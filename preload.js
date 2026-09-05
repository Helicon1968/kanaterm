// レンダラープロセスへ、必要最小限のPTY/タブ操作だけを安全に公開する
const { contextBridge, ipcRenderer } = require('electron');

/** on(...) の記述が並ぶだけなので、購読の定義をまとめて生成する */
function subscribers(channels) {
  const api = {};
  for (const [name, channel] of Object.entries(channels)) {
    api[name] = (callback) => ipcRenderer.on(channel, (_event, payload) => callback(payload));
  }
  return api;
}

contextBridge.exposeInMainWorld('ptyApi', {
  ...subscribers({
    onTabCreate: 'tab:create',
    onTabActivate: 'tab:activate',
    onTabColorChanged: 'tab:color-changed',
    onRequestCloseTab: 'tab:request-close',
    onRequestRenameTab: 'tab:request-rename',
    onRequestPaste: 'tab:request-paste',
    onData: 'pty:data',
    onExit: 'pty:exit',
    onSettingsInit: 'settings:init',
    onSettingsApply: 'settings:apply',
  }),

  write: (tabId, data) => ipcRenderer.send('pty:input', { tabId, data }),
  resize: (tabId, cols, rows) => ipcRenderer.send('pty:resize', { tabId, cols, rows }),
  reportCwd: (tabId, cwd) => ipcRenderer.send('pty:cwd', { tabId, cwd }),

  newTab: (fromTabId) => ipcRenderer.send('tab:new', { fromTabId }),
  closeTab: (tabId) => ipcRenderer.send('tab:close', { tabId }),
  setActiveTab: (tabId) => ipcRenderer.send('tab:active', { tabId }),
  setTabTitle: (tabId, title) => ipcRenderer.send('tab:title', { tabId, title }),
  reorderTabs: (order) => ipcRenderer.send('tab:reorder', { order }),

  saveScrollback: (tabId, content) => ipcRenderer.send('tab:scrollback', { tabId, content }),
  // 終了直前だけは同期で送る。非同期だとウィンドウ破棄に間に合わず取りこぼすため。
  saveScrollbackSync: (tabId, content) =>
    ipcRenderer.sendSync('tab:scrollback-sync', { tabId, content }),

  reportError: (kind, detail) => ipcRenderer.send('log:renderer-error', { kind, detail }),

  copyText: (text) => ipcRenderer.send('clipboard:copy', text),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  confirmMultilinePaste: (lineCount, preview) =>
    ipcRenderer.invoke('paste:confirm', { lineCount, preview }),
  showContextMenu: (tabId) => ipcRenderer.send('context-menu:show', { tabId }),
  showTabContextMenu: (tabId) => ipcRenderer.send('context-menu:tab', { tabId }),
});
