// kanaterm - ファイルログ
//
// DevTools(Ctrl+Shift+I)はレンダラーの、しかも開いている間しか見えない。
// 一方でこのアプリが壊れやすいのは起動時・終了時(設定の復元、シェルの起動、
// 終了時の保存)で、その頃にはDevToolsを開く余地が無い。後から原因を追えるよう、
// mainプロセス側の出来事をファイルに残す。
//
// 2系統の使い分け:
//   INFO以上 : 常時記録。運用者が見て状況が分かる粒度(起動/タブ/失敗)。
//   DEBUG    : 右クリックメニューで有効にした時だけ。原因調査用の細かい記録。
//
// 【重要】通常のログにはPTYの入出力そのもの(打った内容・画面の中身)を記録しない。
// パスワードを打つ場面があるため、DEBUGでもサイズや種別までにとどめる。
//
// 例外は appendCapture() で、これは「タブごとのClaude Codeの状態を画面から判定する」
// ロジックを作るための調査用に、画面に見えている文字をそのまま別ファイルへ残す。
// 性質が違うので既定は無効、有効化には明示的な同意を求め、ファイルも分けている。

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const FILE_PREFIX = 'kanaterm-';
// 画面キャプチャは通常のログとは別ファイルにする。
// 内容の性質(画面に見えている文字がそのまま残る)が違うので、混ぜない。
const CAPTURE_PREFIX = 'screen-capture-';
const FILE_SUFFIX = '.log';
const RETENTION_DAYS = 7;
const DETAIL_MAX_CHARS = 2000;

const pad = (n, width = 2) => String(n).padStart(width, '0');

function dayKey(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function timeKey(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** Error はそのままJSONにすると {} になってしまうので、明示的に開いて文字列化する */
function formatDetail(detail) {
  if (detail === undefined) return '';
  try {
    let text;
    if (detail instanceof Error) {
      text = detail.stack || `${detail.name}: ${detail.message}`;
    } else if (typeof detail === 'string') {
      text = detail;
    } else {
      text = JSON.stringify(detail);
    }
    if (text.length > DETAIL_MAX_CHARS) text = `${text.slice(0, DETAIL_MAX_CHARS)}…(省略)`;
    return ` ${text}`;
  } catch (_err) {
    return ' (詳細を文字列化できませんでした)';
  }
}

function createLogger(userDataDir) {
  const logDir = path.join(userDataDir, 'logs');
  let debugEnabled = false;

  function write(level, scope, message, detail) {
    if (LEVELS[level] > (debugEnabled ? LEVELS.debug : LEVELS.info)) return;

    const now = new Date();
    const line = `${dayKey(now)} ${timeKey(now)} [${level.toUpperCase().padEnd(5)}] [${scope}] ${message}${formatDetail(detail)}`;

    // start.bat から起動した場合はコンソールにも出しておくと、その場で気づける
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);

    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, `${FILE_PREFIX}${dayKey(now)}${FILE_SUFFIX}`), `${line}\n`, 'utf8');
    } catch (_err) {
      // ログが書けないこと自体でアプリを止めるわけにはいかないので握りつぶす
    }
  }

  /**
   * 画面キャプチャを追記する(タブ状態の判定ロジックを作るための調査用)。
   * 通常のログとは違い、画面に見えている文字がそのまま残る。
   */
  function appendCapture(text) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const file = path.join(logDir, `${CAPTURE_PREFIX}${dayKey(new Date())}${FILE_SUFFIX}`);
      fs.appendFileSync(file, `${text}\n`, 'utf8');
    } catch (_err) {
      // 調査用なので、書けなくても動作は続ける
    }
  }

  /** 保存期間を過ぎたログを消す(起動時に一度だけ呼ぶ) */
  function pruneOldLogs() {
    const limit = new Date();
    limit.setDate(limit.getDate() - RETENTION_DAYS);
    const limitKey = dayKey(limit);

    let files;
    try {
      files = fs.readdirSync(logDir);
    } catch (_err) {
      return 0; // まだログを1度も書いていない
    }

    let removed = 0;
    for (const file of files) {
      if (!file.endsWith(FILE_SUFFIX)) continue;
      const prefix = [FILE_PREFIX, CAPTURE_PREFIX].find((p) => file.startsWith(p));
      if (!prefix) continue;
      const key = file.slice(prefix.length, -FILE_SUFFIX.length);
      if (!/^\d{8}$/.test(key) || key >= limitKey) continue;
      try {
        fs.unlinkSync(path.join(logDir, file));
        removed += 1;
      } catch (_err) {
        // 消せなくても実害はない
      }
    }
    return removed;
  }

  /** 出力元を固定したロガーを作る(grepしやすくするため) */
  function scope(name) {
    return {
      error: (message, detail) => write('error', name, message, detail),
      warn: (message, detail) => write('warn', name, message, detail),
      info: (message, detail) => write('info', name, message, detail),
      debug: (message, detail) => write('debug', name, message, detail),
    };
  }

  return {
    scope,
    appendCapture,
    pruneOldLogs,
    logDir,
    // 設定変更時に即座に反映させたいので、起動時に固定せず都度参照する
    setDebug: (on) => {
      debugEnabled = Boolean(on);
    },
    isDebug: () => debugEnabled,
  };
}

module.exports = { createLogger, RETENTION_DAYS };
