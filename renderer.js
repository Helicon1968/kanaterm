// kanaterm - 単一ウィンドウ・複数タブ版レンダラー
//
// 画面の状態は次の2か所で持つ。
//   - tabs (Map)      : タブIDごとの実体(xterm本体・DOM・cwd等)
//   - tabList の子要素 : タブの「並び順」。ドラッグで並べ替えるのはDOMなので、
//                        順序に関する判断は必ずDOMを正として tabIdsInOrder() で読む。
//                        (Mapの列挙順は生成順のままなので、並べ替え後はズレる)

// レンダラーの例外は DevTools を開いていないと消えてしまうので、mainのログへ送る。
// 何よりも先に登録して、この後の初期化中に起きた例外も拾えるようにする。
window.addEventListener('error', (e) => {
  window.ptyApi.reportError('window.onerror', {
    message: e.message,
    source: e.filename,
    line: e.lineno,
    column: e.colno,
    stack: e.error && e.error.stack,
  });
});
window.addEventListener('unhandledrejection', (e) => {
  window.ptyApi.reportError('unhandledrejection', {
    reason: String(e.reason),
    stack: e.reason && e.reason.stack,
  });
});

const tabList = document.getElementById('tab-list');
const panes = document.getElementById('panes');
const newTabBtn = document.getElementById('new-tab-btn');

// tabId -> TabState
const tabs = new Map();
let activeTabId = null;

// フォント・配色は「このPCの設定」。main側の settings:init / settings:apply で同期する。
let currentSettings = { ...PRESETS.DEFAULT_SETTINGS };

// 画面内容を定期的に保存しておく(終了時に少し古い状態しか復元できない、
// という取りこぼしを減らすため)
const SCROLLBACK_SAVE_INTERVAL_MS = 10000;

// タブ作成直後はシェル起動時の初期描画(リサイズへの応答含む)が何度か届くため、
// 固定の待ち時間で賭けるのではなく「出力が実際に届くたびにタイマーをリセットし、
// 一定時間データが来なくなったら最後に復元内容を書き込む」方式にする。
const RESTORE_QUIET_MS = 200;

// 複数行の貼り付け確認ダイアログに載せる最大行数
const PASTE_PREVIEW_LINES = 10;

// --- 表示名 ---------------------------------------------------------------

function shortenCwd(cwd) {
  if (!cwd) return '(new)';
  const parts = cwd.split('\\').filter(Boolean);
  if (parts.length <= 2) return cwd;
  return '...\\' + parts.slice(-2).join('\\');
}

/**
 * OSC 7 で受け取った file:// URI を Windows のパスへ戻す。
 *   file:///D%3A/work/a%20b -> D:\work\a b
 *   file://server/share/dir -> \\server\share\dir   (UNC。ホスト名が入る)
 * 解釈できない値なら null を返す。
 */
function fileUriToWindowsPath(uri) {
  const match = /^file:\/\/([^/]*)(\/.*)$/.exec(uri);
  if (!match) return null;
  const [, host, rawPath] = match;
  let cwdPath;
  try {
    cwdPath = decodeURIComponent(rawPath);
  } catch (_err) {
    return null; // 未エンコードの % を含む等、壊れたURI
  }
  if (/^\/[A-Za-z]:\//.test(cwdPath)) cwdPath = cwdPath.slice(1); // "/D:/..." -> "D:/..."
  cwdPath = cwdPath.replace(/\//g, '\\');
  if (host && host.toLowerCase() !== 'localhost') cwdPath = '\\\\' + host + cwdPath;
  return cwdPath;
}

function updateTabLabel(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;
  // 手動でリネームされていればそちらを優先し、cwdの変化では上書きしない
  t.label.textContent = t.title || shortenCwd(t.cwd);
}

function applyTabColor(tabId, color) {
  const t = tabs.get(tabId);
  if (!t) return;
  t.color = color;
  t.tabEl.style.backgroundColor = PRESETS.tabSwatch(color);
}

// --- 並び順(DOMが正) ------------------------------------------------------

/** 画面に見えている順のタブID一覧 */
function tabIdsInOrder() {
  return Array.from(tabList.children)
    .map((el) => el.dataset.tabId)
    .filter((id) => tabs.has(id));
}

function notifyReorder() {
  window.ptyApi.reorderTabs(tabIdsInOrder());
}

// before=true: targetの手前に挿入 / before=false: targetの直後に挿入
// (targetが最後の行で after を指定すると、そのまま末尾へ移動する)
function reorderTab(draggedId, targetId, before) {
  const draggedEl = tabs.get(draggedId)?.tabEl;
  const targetEl = tabs.get(targetId)?.tabEl;
  if (!draggedEl || !targetEl || draggedEl === targetEl) return;
  // nextSiblingがnullなら末尾に追加される
  tabList.insertBefore(draggedEl, before ? targetEl : targetEl.nextSibling);
  notifyReorder();
}

// --- アクティブタブ --------------------------------------------------------

function activateTab(tabId, { notify = true } = {}) {
  if (!tabs.has(tabId)) return;
  activeTabId = tabId;
  for (const [id, t] of tabs) {
    const isActive = id === tabId;
    t.container.classList.toggle('active', isActive);
    t.tabEl.classList.toggle('active', isActive);
  }
  tabs.get(tabId).term.focus();
  fitActive();
  // main側から指示されたアクティブ化を送り返すと往復するだけなので、そのときは送らない
  if (notify) window.ptyApi.setActiveTab(tabId);
}

function fitActive() {
  const t = tabs.get(activeTabId);
  if (!t) return;
  t.fitAddon.fit();
  // サイズが実際に変わった時だけリサイズを送る。
  // 変わっていないのに毎回送ると、シェル側がそのたびに画面を再描画し、
  // 復元した内容やタブを見るだけで表示が消えてしまう原因になっていた。
  const { cols, rows } = t.term;
  if (t.lastSentCols !== cols || t.lastSentRows !== rows) {
    t.lastSentCols = cols;
    t.lastSentRows = rows;
    window.ptyApi.resize(activeTabId, cols, rows);
  }
}

// --- 復元内容(スクロールバック) --------------------------------------------

// ここでは pendingScrollback をあえて消さない(=使い捨てにしない)。
// フォントサイズ変更など、ユーザーがまだそのタブに何も入力していない間に
// 実際のリサイズが発生すると、シェル側の再描画で復元内容が消えてしまうため、
// 「ユーザーが入力するまでは、再描画が起きるたびに何度でも書き戻す」ようにする。
// ユーザーが実際に入力した時点で clearRestoreGuard() により保護を解除する。
function scheduleScrollbackRestore(tabId) {
  const t = tabs.get(tabId);
  if (!t || !t.pendingScrollback) return;
  clearTimeout(t.restoreTimer);
  t.restoreTimer = setTimeout(() => {
    if (!t.pendingScrollback) return;
    // 複数回書き戻す可能性があるため、そのたびに一度リセットしてから書く。
    // クリアせずに書き戻すと、前回分の末尾に継ぎ足されて内容が重複してしまう。
    t.term.reset();
    t.term.write(t.pendingScrollback);
  }, RESTORE_QUIET_MS);
}

function clearRestoreGuard(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;
  t.pendingScrollback = null;
  clearTimeout(t.restoreTimer);
  t.restoreTimer = null;
}

/**
 * 貼り付けるテキストを行に分ける。
 * 末尾の改行1つは行数に数えない(「コマンド1行 + 改行」は複数行ではないため)。
 */
function splitPasteLines(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n$/, '')
    .split('\n');
}

/** 確認ダイアログに載せる抜粋(長すぎると読めないので先頭のみ) */
function pastePreview(lines) {
  const head = lines.slice(0, PASTE_PREVIEW_LINES).join('\n');
  const rest = lines.length - PASTE_PREVIEW_LINES;
  return rest > 0 ? `${head}\n… 他 ${rest} 行` : head;
}

/**
 * クリップボードの内容をそのタブへ貼り付ける。
 * term.paste() が「CRLF -> CR の正規化」と「ブラケットペースト(\x1b[200~ 〜 \x1b[201~)の
 * 付与」を端末の状態に応じて行う。結果は通常の入力と同じく onData を通るので、
 * PTYへの送信も復元ガードの解除も既存の経路にそのまま乗る。
 */
async function pasteFromClipboard(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;
  const text = await window.ptyApi.readClipboard();
  if (!text) return;

  if (await needsPasteConfirm(t, text)) {
    const lines = splitPasteLines(text);
    const ok = await window.ptyApi.confirmMultilinePaste(lines.length, pastePreview(lines));
    if (!ok) return;
  }

  t.term.paste(text);
  // 確認ダイアログや右クリックメニューでフォーカスが外れているので戻す
  t.term.focus();
}

async function needsPasteConfirm(t, text) {
  if (currentSettings.confirmMultilinePaste === false) return false;
  if (splitPasteLines(text).length < 2) return false;
  // ブラケットペースト対応のシェルなら、複数行でも実行されず入力欄に載るだけなので確認は不要。
  // (現状のPowerShell + ConPTY では無効なので、実際にはほぼ常に確認する)
  if (t.term.modes.bracketedPasteMode) return false;
  return true;
}

function saveScrollback(tabId, { sync = false } = {}) {
  const t = tabs.get(tabId);
  // 内容が変わっていないタブまで毎回シリアライズすると、タブ数に比例して無駄に重くなる
  if (!t || !t.dirty) return;
  try {
    const content = t.serializeAddon.serialize();
    if (sync) {
      window.ptyApi.saveScrollbackSync(tabId, content);
    } else {
      window.ptyApi.saveScrollback(tabId, content);
    }
    t.dirty = false;
  } catch (_err) {
    // シリアライズに失敗しても致命的ではないので無視する
  }
}

// --- タブの生成・破棄 ------------------------------------------------------

function createTerminal(tabId, container) {
  const term = new Terminal({
    fontFamily: '"UDEV Gothic LG", "BIZ UDGothic", monospace',
    fontSize: currentSettings.fontSize,
    theme: PRESETS.themeColors(currentSettings.theme),
    cursorBlink: true,
    scrollback: 5000,
  });
  const fitAddon = new FitAddon.FitAddon();
  const serializeAddon = new SerializeAddon.SerializeAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(serializeAddon);
  term.open(container);

  term.onData((data) => {
    window.ptyApi.write(tabId, data);
    // ユーザーが実際に入力した時点で、復元内容を守る必要はなくなる
    // (以後の再描画は通常の操作によるものなので、そのまま任せてよい)
    clearRestoreGuard(tabId);
  });

  // シェル統合スクリプトが送るOSC7から解析されたcwdを受け取る
  term.parser.registerOscHandler(7, (data) => {
    const cwdPath = fileUriToWindowsPath(data);
    if (cwdPath) {
      const t = tabs.get(tabId);
      if (t) t.cwd = cwdPath;
      window.ptyApi.reportCwd(tabId, cwdPath);
      updateTabLabel(tabId);
    }
    return true;
  });

  return { term, fitAddon, serializeAddon };
}

function createTabRow(tabId, cwd, color, title) {
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.draggable = true;
  tabEl.dataset.tabId = tabId;
  tabEl.style.backgroundColor = PRESETS.tabSwatch(color);

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = title || shortenCwd(cwd);
  label.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRenameTab(tabId);
  });

  const closeBtn = document.createElement('span');
  closeBtn.className = 'close';
  closeBtn.textContent = '×';
  closeBtn.title = 'このタブを閉じる';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    requestCloseTab(tabId);
  });

  tabEl.append(label, closeBtn);
  tabEl.addEventListener('click', () => activateTab(tabId));

  // タブ本体用の右クリックメニュー(色・名前・閉じる)。
  // ターミナル本体用のメニューとは別なので、ここで確実に止めておく。
  tabEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.ptyApi.showTabContextMenu(tabId);
  });

  attachDragHandlers(tabEl, tabId);
  tabList.appendChild(tabEl);
  return { tabEl, label };
}

function attachDragHandlers(tabEl, tabId) {
  tabEl.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', tabId);
    e.dataTransfer.effectAllowed = 'move';
  });
  tabEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    tabEl.classList.add('drag-over');
  });
  tabEl.addEventListener('dragleave', (e) => {
    // 子要素(ラベル等)へ移っただけの dragleave では消さない。消すと線がちらつく。
    if (tabEl.contains(e.relatedTarget)) return;
    tabEl.classList.remove('drag-over');
  });
  tabEl.addEventListener('drop', (e) => {
    e.preventDefault();
    tabEl.classList.remove('drag-over');
    const draggedId = e.dataTransfer.getData('text/plain');
    if (!draggedId || draggedId === tabId) return;
    // ドロップ位置が行の上半分か下半分かで、手前/後ろどちらに挿すかを決める。
    // これにより一番下(最後尾)への移動も可能になる。
    const rect = tabEl.getBoundingClientRect();
    reorderTab(draggedId, tabId, e.clientY < rect.top + rect.height / 2);
  });
}

function createTabUI(tabId, cwd, scrollback, color, title) {
  if (tabs.has(tabId)) return; // 二重生成の保険

  const container = document.createElement('div');
  container.className = 'pane';
  panes.appendChild(container);

  const { term, fitAddon, serializeAddon } = createTerminal(tabId, container);

  // ドラッグで選択した瞬間に自動でクリップボードへコピーする。
  // 右クリック(メニュー表示)でここに入ると選択が意図せず上書きされるので左ボタンのみ。
  container.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    if (term.hasSelection()) window.ptyApi.copyText(term.getSelection());
  });

  const { tabEl, label } = createTabRow(tabId, cwd, color, title);

  tabs.set(tabId, {
    term,
    fitAddon,
    serializeAddon,
    container,
    tabEl,
    label,
    cwd,
    color: color || null,
    title: title || null,
    // 前回終了時に保存された画面内容(まだ書き込んでいない分)。
    // 実行していたプロセスそのものは再現できず、あくまで見た目のスナップショット。
    pendingScrollback: scrollback || null,
    restoreTimer: null,
    // 前回の保存以降に画面が変化したか(定期保存の対象を絞るため)
    dirty: false,
  });

  // main側から明示のアクティブ化指示が来るが、何も表示されない瞬間を作らないよう
  // 最初の1枚だけは即座に出す
  if (!activeTabId) activateTab(tabId, { notify: false });
}

function destroyTabUI(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;
  // 破棄したTerminalに書き込むと例外になるため、復元タイマーを先に止める
  clearTimeout(t.restoreTimer);
  t.term.dispose();
  t.container.remove();
  t.tabEl.remove();
  tabs.delete(tabId);
}

function requestCloseTab(tabId) {
  if (!tabs.has(tabId)) return;

  if (tabs.size <= 1) {
    // 最後の1枚は「タブを閉じる」のではなくウィンドウごと閉じる。
    // これにより記録(state.json)はそのまま残り、次回起動時に復元される。
    window.close();
    return;
  }

  // 閉じた後にどこへ移るかは「見えている並び」で決める(下 -> 無ければ上)
  const ids = tabIdsInOrder();
  const idx = ids.indexOf(tabId);
  const nextId = ids[idx + 1] || ids[idx - 1] || null;
  const wasActive = activeTabId === tabId;

  destroyTabUI(tabId);
  // 手放す前の最後の画面内容は保存しない
  // (main側でこのタブの画面内容ファイルは削除される)
  window.ptyApi.closeTab(tabId);

  if (wasActive && nextId) activateTab(nextId);
}

function startRenameTab(tabId) {
  const t = tabs.get(tabId);
  if (!t || !t.label.isConnected) return; // 既に編集中なら何もしない
  // input内でのテキスト選択がタブのドラッグ操作と衝突しないよう、編集中は無効化する
  t.tabEl.draggable = false;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = t.title || shortenCwd(t.cwd);
  t.label.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const newTitle = input.value.trim();
    t.title = newTitle || null; // 空にしたら自動(cwd由来)表示に戻す
    input.replaceWith(t.label);
    t.tabEl.draggable = true;
    updateTabLabel(tabId);
    window.ptyApi.setTabTitle(tabId, t.title);
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      input.value = t.title || shortenCwd(t.cwd);
      input.blur();
    }
  });
}

// --- メインプロセスからのイベント -------------------------------------------

window.ptyApi.onTabCreate(({ id, cwd, scrollback, color, title }) => {
  createTabUI(id, cwd, scrollback, color, title);
});

window.ptyApi.onTabActivate(({ tabId }) => {
  activateTab(tabId, { notify: false });
});

window.ptyApi.onTabColorChanged(({ tabId, color }) => {
  applyTabColor(tabId, color);
});

window.ptyApi.onRequestCloseTab(({ tabId }) => requestCloseTab(tabId));

window.ptyApi.onRequestRenameTab(({ tabId }) => startRenameTab(tabId));

window.ptyApi.onRequestPaste(({ tabId }) => pasteFromClipboard(tabId));

window.ptyApi.onData(({ tabId, data }) => {
  const t = tabs.get(tabId);
  if (!t) return;
  t.term.write(data);
  t.dirty = true;
  if (t.pendingScrollback) scheduleScrollbackRestore(tabId);
});

window.ptyApi.onExit(({ tabId, code }) => {
  const t = tabs.get(tabId);
  if (!t) return;
  // シェルが終了したタブは、以後どのキーを打っても反応しない。
  // 見た目でそれと分かるようにしておく(タブ自体は明示的に閉じるまで残す)。
  t.exited = true;
  t.tabEl.classList.add('exited');
  t.term.write(`\r\n\r\n[プロセス終了: code=${code}]\r\n`);
  t.dirty = true;
});

window.ptyApi.onSettingsInit((settings) => {
  currentSettings = settings;
});

window.ptyApi.onSettingsApply((settings) => {
  currentSettings = settings;
  const theme = PRESETS.themeColors(currentSettings.theme);
  for (const t of tabs.values()) {
    t.term.options.fontSize = currentSettings.fontSize;
    t.term.options.theme = theme;
  }
  // アクティブなタブは今すぐ反映。非表示のタブは次にアクティブになった時、
  // fitActive() がサイズの変化を検知して自動的に追従する。
  fitActive();
});

// --- 操作 -----------------------------------------------------------------

newTabBtn.addEventListener('click', () => window.ptyApi.newTab(activeTabId));

// タブの行数が少ないと、リスト下部に何もない余白ができる。
// そこへドロップした場合は「末尾へ移動」として扱う
// (個々のタブ行のdropハンドラは、タブ行そのものにドロップした時しか反応しないため)
tabList.addEventListener('dragover', (e) => {
  if (e.target !== tabList) return; // タブ行の上ならそちら側のハンドラに任せる
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});
tabList.addEventListener('drop', (e) => {
  if (e.target !== tabList) return;
  e.preventDefault();
  const draggedEl = tabs.get(e.dataTransfer.getData('text/plain'))?.tabEl;
  if (!draggedEl) return;
  tabList.appendChild(draggedEl);
  notifyReorder();
});

// アプリ側のショートカットは、xterm本体が処理する前にキャプチャフェーズで横取りする。
// xterm は defaultPrevented を見ずにキーをPTYへ送るため、preventDefault だけでは
// 制御文字(Ctrl+V なら ^V、Ctrl+Tab なら TAB)がシェルへ流れてしまう。
// stopPropagation で xterm のリスナーまで届かせないのが要点。
function handleShortcut(e) {
  if (!e.key) return false; // IME確定時など key が無いイベントが来ることがある
  const key = e.key.toLowerCase();

  // Ctrl+V / Ctrl+Shift+V で貼り付け(Windowsの端末としてはCtrl+Vが自然)
  if (e.ctrlKey && !e.altKey && key === 'v') {
    if (activeTabId) pasteFromClipboard(activeTabId);
    return true;
  }
  if (e.ctrlKey && e.shiftKey && key === 't') {
    window.ptyApi.newTab(activeTabId);
    return true;
  }
  if (e.ctrlKey && e.shiftKey && key === 'w') {
    if (activeTabId) requestCloseTab(activeTabId);
    return true;
  }
  if (e.ctrlKey && e.key === 'Tab') {
    // 見えている並びで循環させる(Mapの列挙順は並べ替えを反映しない)
    const ids = tabIdsInOrder();
    if (ids.length > 1) {
      const idx = ids.indexOf(activeTabId);
      const step = e.shiftKey ? -1 : 1;
      activateTab(ids[(idx + step + ids.length) % ids.length]);
    }
    return true;
  }
  return false;
}

window.addEventListener(
  'keydown',
  (e) => {
    // タブ名の編集中(input)は、ブラウザ標準のテキスト編集(Ctrl+V等)に任せる
    if (e.target instanceof HTMLInputElement) return;
    if (!handleShortcut(e)) return;
    e.preventDefault();
    e.stopPropagation();
  },
  true
);

// ウィンドウのリサイズ中は大量にイベントが来るので、描画1フレームにつき1回へ間引く
let fitScheduled = false;
window.addEventListener('resize', () => {
  if (fitScheduled) return;
  fitScheduled = true;
  requestAnimationFrame(() => {
    fitScheduled = false;
    fitActive();
  });
});

// 右クリックでコンテキストメニューを表示する
window.addEventListener('contextmenu', (e) => {
  // タブ名の編集中(input)は、テキスト編集の妨げになるので何も出さない
  if (e.target instanceof HTMLInputElement) return;
  e.preventDefault();
  if (activeTabId) window.ptyApi.showContextMenu(activeTabId);
});

setInterval(() => {
  for (const tabId of tabs.keys()) saveScrollback(tabId);
}, SCROLLBACK_SAVE_INTERVAL_MS);

// ウィンドウが閉じる直前に最後の画面内容を確定させる。
// 非同期の送信だとウィンドウ破棄に間に合わないことがあるため、ここだけ同期で送る。
window.addEventListener('beforeunload', () => {
  for (const tabId of tabs.keys()) saveScrollback(tabId, { sync: true });
});
