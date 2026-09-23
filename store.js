// kanaterm - 永続化(state.json とスクロールバック)の担当
//
// mainプロセスの処理からファイルI/Oを切り離しておくことで、
// 「保存の失敗でアプリが落ちない」ことをこのファイルの中だけで保証できる。
// 呼び出し側は成否を気にせず素直に呼べる。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { DEFAULT_SETTINGS } = require('./presets');

const DEFAULT_WINDOW_BOUNDS = { width: 1100, height: 680 };

function defaultCwd() {
  return process.env.USERPROFILE || process.cwd();
}

/** ロガーを渡さずに使えるよう、何もしないロガーを既定にしておく */
const NULL_LOG = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

/**
 * userDataDir 配下に state.json を持つストアを作る。
 * app.getPath('userData') に依存させないことで、単体でも動かせるようにしている。
 */
function createStore(userDataDir, log = NULL_LOG) {
  const stateFile = path.join(userDataDir, 'state.json');
  // 以前の版が画面内容を保存していた場所(今は削除するためだけに参照する)
  const scrollbackDir = path.join(userDataDir, 'scrollback');

  /** 前回終了時の状態。壊れていた場合・初回起動時は既定値を返す。 */
  function loadState() {
    const fallback = {
      window: { ...DEFAULT_WINDOW_BOUNDS },
      tabs: [{ id: crypto.randomUUID(), cwd: defaultCwd(), color: null, title: null }],
      settings: { ...DEFAULT_SETTINGS },
      activeTabId: null,
    };

    let state;
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (err) {
      // 初回起動でファイルが無いのは異常ではないが、壊れたJSONは記録に値する
      if (err.code === 'ENOENT') log.info('state.json が無いため既定値で開始します');
      else log.warn('state.json を読めないため既定値で開始します', err);
      return fallback;
    }

    if (!state || !Array.isArray(state.tabs) || state.tabs.length === 0) {
      log.warn('state.json にタブの記録が無いため既定値で開始します');
      return fallback;
    }

    // 手で編集された state.json でも起動できるよう、1件ずつ型を整えてから使う
    const tabs = state.tabs
      .filter((t) => t && typeof t.id === 'string')
      .map((t) => ({
        id: t.id,
        cwd: typeof t.cwd === 'string' ? t.cwd : defaultCwd(),
        color: typeof t.color === 'string' ? t.color : null,
        title: typeof t.title === 'string' && t.title ? t.title : null,
      }));
    if (tabs.length === 0) {
      log.warn('state.json のタブがすべて不正だったため既定値で開始します');
      return fallback;
    }
    if (tabs.length !== state.tabs.length) {
      log.warn('state.json の一部のタブを読み飛ばしました', {
        記録: state.tabs.length,
        採用: tabs.length,
      });
    }

    return {
      window: { ...DEFAULT_WINDOW_BOUNDS, ...(state.window || {}) },
      tabs,
      settings: { ...DEFAULT_SETTINGS, ...(state.settings || {}) },
      activeTabId: tabs.some((t) => t.id === state.activeTabId) ? state.activeTabId : tabs[0].id,
    };
  }

  function saveState(data) {
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      log.error('state.json の保存に失敗しました', err);
    }
  }

  /**
   * 以前の版が保存していた画面内容(scrollback/)を消す。
   * 画面内容の保存は廃止したが、端末の出力そのもの(パスワード等を含みうる)なので
   * 不要になった分を残しておかない。起動時に一度だけ呼ぶ。
   */
  function removeLegacyScrollback() {
    if (!fs.existsSync(scrollbackDir)) return false;
    try {
      fs.rmSync(scrollbackDir, { recursive: true, force: true });
      log.info('以前の版が保存した画面内容を削除しました', { path: scrollbackDir });
      return true;
    } catch (err) {
      log.warn('以前の版が保存した画面内容を削除できませんでした', { err: String(err) });
      return false;
    }
  }

  return {
    loadState,
    saveState,
    removeLegacyScrollback,
  };
}

module.exports = { createStore, DEFAULT_WINDOW_BOUNDS, defaultCwd };
