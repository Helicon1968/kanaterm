// kanaterm - 単一ウィンドウ + 複数タブ (mainプロセス)
//
// ウィンドウは常に1つ。ターミナルは同一ウィンドウ内のタブとして複数持てる。
// 二重起動(`npm start`を複数回実行 等)はシングルインスタンス化で防ぎ、
// 既存ウィンドウへ新規タブを追加する形にする(2回目の起動時のカレント
// ディレクトリを、そのタブの初期cwdとして引き継ぐ)。
//
// ウィンドウが1つしか存在しないため、「ウィンドウが閉じる」は
// 常に「アプリ終了」を意味する。個別にタブを閉じる操作(まだ他のタブが
// 残る場合)とは明確に区別できる。
//   - 他のタブが残る状態でタブを閉じる   -> 即座に確定して記録から外す
//   - 最後の1枚のタブを閉じようとする     -> タブではなくウィンドウ自体を閉じる
//                                           (記録は変更せずそのまま次回に残す)
//   - ウィンドウが閉じる(=アプリ終了)     -> 記録を確定させてから全PTYを止める

const { app, BrowserWindow, ipcMain, Menu, clipboard, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const pty = require('@lydell/node-pty');

const { DEFAULT_SETTINGS } = require('./presets');
const { createStore, DEFAULT_WINDOW_BOUNDS, defaultCwd } = require('./store');
const { createLogger, RETENTION_DAYS } = require('./logger');
const { buildTerminalMenuTemplate, buildTabMenuTemplate } = require('./menus');

const SHELL = 'powershell.exe';
const SHELL_ARGS = ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File'];
const SHELL_INTEGRATION = path.join(__dirname, 'shell-integration.ps1');
const SAVE_DEBOUNCE_MS = 500;

// レンダラー側で fit() が走るまでの暫定サイズ。すぐ上書きされるので値自体に意味はない。
const PTY_INITIAL_COLS = 100;
const PTY_INITIAL_ROWS = 30;

/**
 * 子シェルへ渡す環境変数。
 * Electron本体向けの変数をそのまま渡すと、シェルから node を起動したときに
 * 挙動が変わってしまうため取り除く。
 */
function shellEnv() {
  const env = { ...process.env, TERM: 'xterm-256color' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

/**
 * 復元したcwdが既に存在しないことがある(外付け/ネットワークドライブ、削除済みフォルダ)。
 * その状態で pty.spawn すると例外になり、そのタブが開けなくなるのでホームへ退避する。
 */
function resolveCwd(cwd) {
  try {
    if (cwd && fs.statSync(cwd).isDirectory()) return cwd;
  } catch (_err) {
    // 存在しない・アクセスできない
  }
  return defaultCwd();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  main();
}

function main() {
  const logger = createLogger(app.getPath('userData'));
  const log = logger.scope('main');
  const store = createStore(app.getPath('userData'), logger.scope('store'));

  let mainWindow = null;
  let settings = { ...DEFAULT_SETTINGS };
  let activeTabId = null;

  // ウィンドウ破棄後は getBounds() が呼べないため、最後に見えていた位置を覚えておく。
  // これを持たないと「サイズ変更直後に閉じる」と既定サイズで保存されてしまう。
  let lastBounds = { ...DEFAULT_WINDOW_BOUNDS };

  // 自分で setBounds した直後の実測値。これとほぼ同じ変化は「適用結果の丸め」として
  // 無視し、保存値には反映しない(詳しくは rememberBounds のコメント)。
  let appliedBounds = { x: 0, y: 0, width: 0, height: 0 };

  // ウィンドウを閉じた後は tabs を空にするので、その状態で保存すると記録が消える。
  // 閉じる時点の内容で確定させ、以降の保存は受け付けない。
  let stateFrozen = false;

  // tabId(UUID) -> { ptyProcess, cwd, color, title, exited }
  const tabs = new Map();
  // 表示順(タブID配列)。並べ替えはこの配列を差し替えるだけで表現する。
  let tabOrder = [];

  // --- 保存 ---------------------------------------------------------------

  let saveTimer = null;

  function scheduleSave() {
    if (stateFrozen) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }

  /** 遅延保存を待たずに今すぐ書き出す(終了直前など、次の機会が無い場面で使う) */
  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (stateFrozen) return;

    // ここで getBounds() を読んではいけない。
    // 高DPI(125%等)では論理座標が整数のデバイスピクセルに乗らないことがあり、
    // 「setBounds で置く -> getBounds で読む -> 保存する」を起動のたびに繰り返すと
    // 丸め誤差が1〜2pxずつ入ってウィンドウが少しずつ育つ。
    // lastBounds は「利用者が実際に動かした/変えた時(moved/resized)」だけ更新し、
    // 何もしなければ読み込んだ値をそのまま書き戻す。
    store.saveState({
      window: lastBounds,
      tabs: tabOrder
        .filter((id) => tabs.has(id))
        .map((id) => {
          const t = tabs.get(id);
          return { id, cwd: t.cwd, color: t.color || null, title: t.title || null };
        }),
      settings,
      activeTabId,
    });
    log.debug('状態を保存しました', { タブ数: tabs.size, activeTabId, window: lastBounds });
  }

  // --- レンダラーとのやりとり ----------------------------------------------

  function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  }

  function applySettings(partial) {
    settings = { ...settings, ...partial };
    // 起動時に固定せず都度反映するので、詳細ログのON/OFFは再起動なしで効く
    logger.setDebug(settings.debugLog === true);
    scheduleSave();
    send('settings:apply', settings);
    log.debug('設定を変更しました', partial);
  }

  // --- PTY / タブ ----------------------------------------------------------

  function spawnPty(tabId, cwd) {
    const ptyProcess = pty.spawn(SHELL, [...SHELL_ARGS, SHELL_INTEGRATION], {
      name: 'xterm-256color',
      cols: PTY_INITIAL_COLS,
      rows: PTY_INITIAL_ROWS,
      cwd,
      env: shellEnv(),
    });

    ptyProcess.onData((data) => send('pty:data', { tabId, data }));
    ptyProcess.onExit(({ exitCode }) => {
      const t = tabs.get(tabId);
      if (t) t.exited = true; // 死んだPTYへの書き込みを避けるための目印
      log.info('シェルが終了しました', { tabId, code: exitCode });
      send('pty:exit', { tabId, code: exitCode });
    });

    return ptyProcess;
  }

  function addTab(tabId, cwd, { color = null, title = null, activate = true } = {}) {
    const resolvedCwd = resolveCwd(cwd);
    if (cwd && resolvedCwd !== cwd) {
      log.warn('cwdが見つからないためホームで開きます', { tabId, 要求: cwd, 実際: resolvedCwd });
    }

    let ptyProcess = null;
    try {
      ptyProcess = spawnPty(tabId, resolvedCwd);
    } catch (err) {
      // シェルが起動できないのはアプリ全体の異常だが、ここで例外を投げると
      // 他のタブごと巻き込むので、そのタブだけ「終了済み」として扱う。
      log.error('シェルを起動できませんでした', { tabId, cwd: resolvedCwd, err: String(err) });
    }

    tabs.set(tabId, {
      ptyProcess,
      cwd: resolvedCwd,
      color,
      title,
      exited: ptyProcess === null,
    });
    tabOrder.push(tabId);
    scheduleSave();

    // 既存の(前回セッションで保存された)画面内容があれば一緒に渡す。
    // 新規タブの場合は該当ファイルが無いので空文字になる。
    // 「復元されない」という相談を受けた時に、渡すものが有ったのかどうかを
    // まずここで切り分けられるよう、文字数を残しておく(内容は残さない)。
    const scrollback = store.readScrollback(tabId);
    log.info('タブを作成しました', {
      tabId,
      cwd: resolvedCwd,
      起動: Boolean(ptyProcess),
      復元文字数: scrollback.length,
    });

    send('tab:create', {
      id: tabId,
      cwd: resolvedCwd,
      scrollback,
      color,
      title,
    });
    if (!ptyProcess) send('pty:exit', { tabId, code: -1 });
    if (activate) setActiveTab(tabId);
  }

  function setActiveTab(tabId) {
    if (!tabs.has(tabId)) return;
    activeTabId = tabId;
    send('tab:activate', { tabId });
    scheduleSave();
  }

  function removeTab(tabId) {
    const t = tabs.get(tabId);
    if (!t) return;
    if (t.ptyProcess) t.ptyProcess.kill();
    tabs.delete(tabId);
    tabOrder = tabOrder.filter((id) => id !== tabId);
    store.deleteScrollback(tabId); // 手放したタブの画面内容は残さない
    if (activeTabId === tabId) activeTabId = tabOrder[0] || null;
    scheduleSave();
    log.info('タブを閉じました', { tabId, 残り: tabs.size });
  }

  function writeToTab(tabId, data) {
    const t = tabs.get(tabId);
    if (t && t.ptyProcess && !t.exited) t.ptyProcess.write(data);
  }

  // --- ログ ----------------------------------------------------------------

  function openLogFolder() {
    try {
      fs.mkdirSync(logger.logDir, { recursive: true });
    } catch (_err) {
      // 開けなければ下の openPath がエラーを返すだけなので、ここでは何もしない
    }
    shell.openPath(logger.logDir);
  }

  /**
   * 詳細ログの切り替え。
   * ログレベルは出力のたびに参照するので、この場で効く(再起動は不要)。
   * ただし起動時の処理は既に終わっているため、その詳細は次回起動分からになる。
   * 分かりにくい差なので、有効にしたときだけその旨を案内する。
   */
  function setDebugLog(on) {
    applySettings({ debugLog: on });
    log.info(on ? '詳細ログを有効にしました' : '詳細ログを無効にしました');
    if (!on || !mainWindow || mainWindow.isDestroyed()) return;

    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        noLink: true,
        title: '詳細ログ',
        message: '詳細ログ(デバッグ)の記録を開始しました。',
        detail: [
          'この設定は今すぐ反映されます(再起動は不要です)。',
          '',
          'ただし起動時の処理 — 設定の読み込み・タブの復元・シェルの起動 — は',
          'すでに終わっているため、その詳細は次回の起動から記録されます。',
          '起動まわりの不具合を調べたい場合は、一度 kanaterm を再起動してください。',
          '',
          `保存先: ${logger.logDir}`,
          `${RETENTION_DAYS}日より古いログは起動時に自動削除されます。`,
        ].join('\n'),
        buttons: ['OK', 'ログフォルダを開く'],
        defaultId: 0,
        cancelId: 0,
      })
      .then(({ response }) => {
        if (response === 1) openLogFolder();
      });
  }

  /**
   * 画面キャプチャの切り替え。
   * 通常のログと違い「画面に見えている文字」がそのまま残るため、
   * 有効にするときは何が記録されるかを明示して同意を取る。
   */
  function setCaptureScreen(on) {
    if (!on) {
      applySettings({ captureScreen: false });
      log.info('画面キャプチャを停止しました');
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) return;

    dialog
      .showMessageBox(mainWindow, {
        type: 'warning',
        noLink: true,
        title: '画面キャプチャ',
        message: '各タブの画面内容をファイルに記録します。',
        detail: [
          'タブごとのClaude Codeの状態(作業中/確認待ち/待機中)を判定する仕組みを',
          '作るための調査用の機能です。出力が落ち着くたびに、そのタブの画面末尾を',
          'そのままファイルへ書き出します。',
          '',
          '【記録される内容】画面に表示されている文字がそのまま残ります。',
          'ファイル名やコマンド、コマンドの出力も含まれます。見られたくない内容を',
          '扱う場合は有効にしないでください。',
          '',
          `保存先: ${logger.logDir}`,
          'ファイル名: screen-capture-YYYYMMDD.log（通常のログとは別ファイル）',
          `${RETENTION_DAYS}日より古い分は起動時に自動削除されます。`,
        ].join('\n'),
        buttons: ['記録を開始する', 'やめる'],
        defaultId: 1,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response !== 0) return;
        applySettings({ captureScreen: true });
        log.info('画面キャプチャを開始しました');
      });
  }

  // --- ウィンドウ ----------------------------------------------------------

  function createMainWindow(initial) {
    settings = { ...DEFAULT_SETTINGS, ...(initial.settings || {}) };
    logger.setDebug(settings.debugLog === true);
    lastBounds = { ...DEFAULT_WINDOW_BOUNDS, ...(initial.window || {}) };
    stateFrozen = false;

    mainWindow = new BrowserWindow({
      ...lastBounds,
      title: 'kanaterm',
      backgroundColor: '#1e1e2e',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // 高DPI環境(拡大率125%等)では、コンストラクタに渡したサイズと getBounds() の
    // 戻り値が数px ずれる。保存 -> 復元を繰り返すたびにウィンドウが少しずつ育って
    // しまうため、生成後に setBounds() で入れ直して往復を一致させる。
    mainWindow.setBounds(lastBounds);
    appliedBounds = mainWindow.getBounds(); // 丸め込まれた実測値を控える

    mainWindow.loadFile('index.html');

    // メニューバーを外した副作用で Ctrl+Shift+I の既定ショートカットも
    // 消えてしまうため、DevTools 開閉だけは個別に効くようにしておく。
    // before-input-event は keyDown / keyUp の両方で呼ばれるため、
    // keyDown に限定しないと開いた直後に閉じてしまい、何も起きないように見える。
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return;
      if (input.control && input.shift && input.key.toLowerCase() === 'i') {
        mainWindow.webContents.toggleDevTools();
      }
    });

    mainWindow.webContents.on('did-finish-load', () => {
      send('settings:init', settings);

      if (tabs.size === 0) {
        // 通常の起動。前回の記録からタブを作る。
        log.info('前回の状態を復元します', { タブ数: initial.tabs.length });
        for (const t of initial.tabs) {
          addTab(t.id, t.cwd, { color: t.color, title: t.title, activate: false });
        }
        setActiveTab(tabs.has(initial.activeTabId) ? initial.activeTabId : tabOrder[0]);
      } else {
        // DevTools等からのページ再読み込み。PTYは生きたままなので、
        // UIだけ作り直して既存のタブに繋ぎ直す(何もしないと画面が空のままになる)。
        log.info('画面を再読み込みしたため、既存タブのUIを作り直します', { タブ数: tabs.size });
        for (const id of tabOrder) {
          const t = tabs.get(id);
          send('tab:create', {
            id,
            cwd: t.cwd,
            scrollback: store.readScrollback(id),
            color: t.color,
            title: t.title,
          });
          if (t.exited) send('pty:exit', { tabId: id, code: -1 });
        }
        setActiveTab(tabs.has(activeTabId) ? activeTabId : tabOrder[0]);
      }
    });

    // ウィンドウ破棄後は getBounds() を呼べないので、変化した時点で控えておく。
    //
    // ここが微妙なところ:
    //   - 高DPI(125%等)では、自分で setBounds した値と getBounds の戻りが数pxずれる。
    //     その差を素直に保存すると、起動のたびにウィンドウが少しずつ育つ。
    //   - かといって「利用者がドラッグし終えた時(resized)」だけを見ると、
    //     スナップ・最大化・プログラム由来のサイズ変更を取りこぼす。
    // そこで「あらゆる変化(resize/move)を見るが、自分が適用した値とほぼ同じなら
    // それは適用結果の丸めなので無視する」ことにする。
    // 数px単位のリサイズを意図的に行うことはないので、実害は無い。
    const ROUNDING_TOLERANCE_PX = 4;
    const nearlySame = (a, b) =>
      Math.abs(a.x - b.x) <= ROUNDING_TOLERANCE_PX &&
      Math.abs(a.y - b.y) <= ROUNDING_TOLERANCE_PX &&
      Math.abs(a.width - b.width) <= ROUNDING_TOLERANCE_PX &&
      Math.abs(a.height - b.height) <= ROUNDING_TOLERANCE_PX;

    const rememberBounds = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const current = mainWindow.getBounds();
      if (nearlySame(current, appliedBounds)) return; // 自分で置いた分の丸め
      lastBounds = current;
      scheduleSave();
    };
    mainWindow.on('move', rememberBounds);
    mainWindow.on('resize', rememberBounds);

    // 見に来たら点滅を止める(気づかせるのが目的なので、見た時点で用は済んでいる)
    mainWindow.on('focus', () => mainWindow.flashFrame(false));

    // ×ボタンなどOS側から閉じる場合はここが呼ばれる。生きているうちに確定させる。
    mainWindow.on('close', () => {
      log.debug('ウィンドウを閉じます');
      flushSave();
    });

    mainWindow.on('closed', () => {
      // ウィンドウは1つだけなので、閉じる = アプリ終了。
      //
      // 【重要】レンダラー発の window.close()(最後のタブを閉じた時の経路)では
      // 上の 'close' が発火しない。確定はこの closed で行う必要がある。
      // また flushSave() は stateFrozen より必ず前に呼ぶこと。順序が逆だと
      // 保存が空振りし、終了直前の変更(リネーム・色・並び)が失われる。
      log.info('ウィンドウが閉じました(記録を確定してシェルを停止します)', { タブ数: tabs.size });
      flushSave();
      stateFrozen = true;
      clearTimeout(saveTimer);
      saveTimer = null;
      for (const t of tabs.values()) {
        if (t.ptyProcess) t.ptyProcess.kill();
      }
      tabs.clear();
      tabOrder = [];
      activeTabId = null;
      mainWindow = null;
    });
  }

  // --- IPC -----------------------------------------------------------------

  ipcMain.on('pty:input', (_event, { tabId, data }) => writeToTab(tabId, data));

  ipcMain.on('pty:resize', (_event, { tabId, cols, rows }) => {
    const t = tabs.get(tabId);
    if (!t || !t.ptyProcess || t.exited) return;
    try {
      t.ptyProcess.resize(cols, rows);
    } catch (_err) {
      // リサイズ中の一瞬のサイズ不整合は無視してよい
    }
  });

  ipcMain.on('pty:cwd', (_event, { tabId, cwd }) => {
    const t = tabs.get(tabId);
    if (t) {
      t.cwd = cwd;
      scheduleSave();
    }
  });

  ipcMain.on('tab:new', (_event, { fromTabId } = {}) => {
    const from = fromTabId && tabs.get(fromTabId);
    addTab(crypto.randomUUID(), from ? from.cwd : undefined);
  });

  // まだ他のタブが残る状態で閉じる = 明確に「手放した」ので即座に確定する
  ipcMain.on('tab:close', (_event, { tabId }) => removeTab(tabId));

  // レンダラー側でアクティブタブが変わった時の通知。
  // 次回起動時に「最後に見ていたタブ」を開くために記録しておく。
  ipcMain.on('tab:active', (_event, { tabId }) => {
    if (!tabs.has(tabId) || activeTabId === tabId) return;
    activeTabId = tabId;
    scheduleSave();
  });

  ipcMain.on('tab:title', (_event, { tabId, title }) => {
    const t = tabs.get(tabId);
    if (t) {
      t.title = title || null;
      scheduleSave();
    }
  });

  ipcMain.on('tab:reorder', (_event, { order }) => {
    if (!Array.isArray(order)) return;
    const valid = order.filter((id) => tabs.has(id));
    for (const id of tabOrder) if (!valid.includes(id)) valid.push(id); // 抜けがあれば末尾へ
    tabOrder = valid;
    scheduleSave();
  });

  // 定期保存でレンダラーから送られてくる画面内容
  ipcMain.on('tab:scrollback', (_event, { tabId, content }) => {
    if (tabs.has(tabId)) store.writeScrollback(tabId, content);
  });

  // 終了直前の保存。非同期の send だとウィンドウ破棄に間に合わず取りこぼすため、
  // このときだけ同期IPCを使って「書き終わってから閉じる」ことを保証する。
  ipcMain.on('tab:scrollback-sync', (event, { tabId, content }) => {
    if (tabs.has(tabId)) store.writeScrollback(tabId, content);
    event.returnValue = true;
  });

  // タブごとのClaude Codeの状態。●の表示はレンダラーが持ち、
  // main側は「ウィンドウが裏にいても気づける」部分だけを受け持つ。
  ipcMain.on('tab:status', (_event, { counts, attention }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    // タスクバーのタイトルにも出す(最小化中やAlt+Tabでも見える)
    const 見出し = counts.waiting > 0 ? '確認待ち' : counts.busy > 0 ? '作業中' : null;
    const title = 見出し ? `[${見出し}] kanaterm` : 'kanaterm';
    if (mainWindow.getTitle() !== title) mainWindow.setTitle(title);

    // 確認待ちになった瞬間だけ点滅させる。見ている最中に光らせても意味がないので、
    // ウィンドウが前面にある時は鳴らさない。
    if (attention && !mainWindow.isFocused()) {
      mainWindow.flashFrame(true);
      log.info('確認待ちのタブが発生しました', counts);
    }
    if (counts.waiting === 0) mainWindow.flashFrame(false);
  });

  // 画面キャプチャ(調査用)。設定が有効なときだけレンダラーから送られてくる。
  ipcMain.on('capture:screen', (_event, payload) => {
    if (settings.captureScreen !== true) return; // 設定を切った直後の取りこぼしを弾く
    const t = tabs.get(payload.tabId);
    const header = [
      '===== ' + new Date().toISOString(),
      'tab=' + payload.tabId,
      'name=' + ((t && (t.title || t.cwd)) || '?'),
      'buffer=' + payload.bufferType,
      'cursor=' + payload.cursorX + ',' + payload.cursorY,
      'rows=' + payload.rows,
      // 直近のプロンプト(OSC 7)からの経過。大きいほど「コマンド実行中」の可能性が高い
      'sincePrompt=' + (payload.sincePromptMs === null ? 'none' : payload.sincePromptMs + 'ms'),
    ].join(' | ');
    logger.appendCapture([header, payload.text, ''].join('\n'));
  });

  // レンダラーで起きた例外。DevToolsを開いていないと消えてしまうのでログへ回す。
  ipcMain.on('log:renderer-error', (_event, { kind, detail }) => {
    logger.scope('renderer').error(String(kind), detail);
  });

  // レンダラー側の通常の記録。レベルは決まったものだけ受け付ける。
  ipcMain.on('log:renderer', (_event, { level, message, detail }) => {
    const scoped = logger.scope('renderer');
    const write = { error: scoped.error, warn: scoped.warn, info: scoped.info, debug: scoped.debug };
    (write[level] || scoped.info)(String(message), detail);
  });

  // マウスドラッグで選択したテキストを自動的にクリップボードへコピーする
  ipcMain.on('clipboard:copy', (_event, text) => {
    if (text) clipboard.writeText(text);
  });

  // 貼り付けの実処理はレンダラー側(xtermのpaste)が持つ。
  // 改行の正規化やブラケットペーストの判断は端末の状態が要るため。
  ipcMain.handle('clipboard:read', () => clipboard.readText());

  // 複数行の貼り付けは、行数ぶんのコマンドがそのまま実行される。
  // 意図しない実行を防ぐため、貼り付ける前に内容を見せて確認する。
  ipcMain.handle('paste:confirm', async (_event, { lineCount, preview }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const { response, checkboxChecked } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      noLink: true,
      title: '複数行の貼り付け',
      message: `${lineCount}行のテキストを貼り付けます。`,
      detail: `シェルは改行を受け取った時点で各行を実行します。内容を確認してください。\n\n${preview}`,
      buttons: ['貼り付け', 'キャンセル'],
      defaultId: 0, // Enterで貼り付け
      cancelId: 1, // Escでキャンセル
      checkboxLabel: '今後この確認を表示しない',
      checkboxChecked: false,
    });
    const confirmed = response === 0;
    // 「表示しない」は貼り付けを選んだ時だけ反映する
    // (キャンセルと同時に無効化されると、次回いきなり実行されて危ない)
    if (confirmed && checkboxChecked) applySettings({ confirmMultilinePaste: false });
    return confirmed;
  });

  // ターミナル本体の右クリックメニュー
  ipcMain.on('context-menu:show', (_event, { tabId }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const template = buildTerminalMenuTemplate({
      settings,
      actions: {
        newTab: () => {
          const from = tabs.get(tabId);
          addTab(crypto.randomUUID(), from ? from.cwd : undefined);
        },
        paste: () => send('tab:request-paste', { tabId }),
        // 「最後の1枚か」の判定はレンダラー側が持っているので、そちらに委ねる
        closeTab: () => send('tab:request-close', { tabId }),
        setFontSize: (fontSize) => applySettings({ fontSize }),
        setTheme: (theme) => applySettings({ theme }),
        setConfirmMultilinePaste: (on) => applySettings({ confirmMultilinePaste: on }),
        setDebugLog,
        setCaptureScreen,
        openLogFolder,
      },
    });
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  // タブ本体(サイドバーの行)の右クリックメニュー
  ipcMain.on('context-menu:tab', (_event, { tabId }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const t = tabs.get(tabId);
    if (!t) return;
    const template = buildTabMenuTemplate({
      tabColor: t.color,
      actions: {
        setColor: (color) => {
          t.color = color;
          scheduleSave();
          send('tab:color-changed', { tabId, color });
        },
        rename: () => send('tab:request-rename', { tabId }),
        closeTab: () => send('tab:request-close', { tabId }),
      },
    });
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  // --- アプリのライフサイクル ----------------------------------------------

  app.whenReady().then(() => {
    // File/Edit/View/Window の既定メニューは自作端末では不要なので外す
    Menu.setApplicationMenu(null);

    const initial = store.loadState();
    // 詳細ログの設定は state.json にあるので、起動直後の記録から効かせる
    logger.setDebug(initial.settings.debugLog === true);
    log.info('kanaterm を起動しました', {
      version: app.getVersion(),
      electron: process.versions.electron,
      userData: app.getPath('userData'),
      詳細ログ: logger.isDebug(),
    });
    const 削除数 = logger.pruneOldLogs();
    if (削除数 > 0) log.debug('古いログを削除しました', { 件数: 削除数 });

    // 異常終了などで取り残されたスクロールバックをここで一掃しておく
    store.pruneScrollback(initial.tabs.map((t) => t.id));
    createMainWindow(initial);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow(store.loadState());
    });
  });

  // 2重起動時: 既存ウィンドウへ新規タブを追加する。
  // 2回目の起動元のカレントディレクトリを、そのタブの初期cwdにする。
  app.on('second-instance', (_event, _argv, workingDirectory) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    addTab(crypto.randomUUID(), workingDirectory);
  });

  app.on('before-quit', () => {
    log.info('kanaterm を終了します');
    flushSave();
  });

  // ここまで来る例外はアプリを巻き込むので、必ず記録に残してから既定の挙動に任せる
  process.on('uncaughtException', (err) => log.error('未捕捉の例外', err));
  process.on('unhandledRejection', (reason) => log.error('未処理のPromise', String(reason)));

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
