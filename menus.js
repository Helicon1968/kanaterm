// kanaterm - 右クリックメニューの組み立て
//
// メニューは「何を並べるか」だけをここに書き、実際の処理(タブ追加・貼り付け等)は
// 呼び出し側から actions として受け取る。main.js 側の状態管理と混ざらないようにするため。

const {
  FONT_SIZE_PRESETS,
  THEME_PRESETS,
  TAB_COLOR_PRESETS,
  NO_TAB_COLOR_LABEL,
} = require('./presets');

/** ターミナル本体を右クリックしたときのメニュー */
function buildTerminalMenuTemplate({ settings, actions }) {
  // accelerator は表示のためだけに付ける。実際のキー処理はレンダラー側で行うので、
  // registerAccelerator: false にしてメニュー側では登録させない(二重発火の防止)。
  return [
    { label: '新規タブ', accelerator: 'Ctrl+Shift+T', registerAccelerator: false, click: actions.newTab },
    { label: '貼り付け', accelerator: 'Ctrl+V', registerAccelerator: false, click: actions.paste },
    { label: '閉じる', accelerator: 'Ctrl+Shift+W', registerAccelerator: false, click: actions.closeTab },
    { type: 'separator' },
    {
      label: 'フォントサイズ',
      submenu: FONT_SIZE_PRESETS.map((size) => ({
        label: `${size}pt`,
        type: 'radio',
        checked: settings.fontSize === size,
        click: () => actions.setFontSize(size),
      })),
    },
    {
      label: '配色',
      submenu: Object.entries(THEME_PRESETS).map(([key, preset]) => ({
        label: preset.label,
        type: 'radio',
        checked: settings.theme === key,
        click: () => actions.setTheme(key),
      })),
    },
    { type: 'separator' },
    {
      // 確認ダイアログで「今後表示しない」を選んだあと、ここから戻せるようにしておく
      label: '複数行の貼り付け前に確認する',
      type: 'checkbox',
      checked: settings.confirmMultilinePaste !== false,
      click: () => actions.setConfirmMultilinePaste(settings.confirmMultilinePaste === false),
    },
    {
      label: 'ログ',
      submenu: [
        {
          label: '詳細ログ(デバッグ)を記録する',
          type: 'checkbox',
          checked: settings.debugLog === true,
          click: () => actions.setDebugLog(settings.debugLog !== true),
        },
        { type: 'separator' },
        { label: 'ログフォルダを開く', click: actions.openLogFolder },
      ],
    },
  ];
}

/** タブ(サイドバーの行)を右クリックしたときのメニュー */
function buildTabMenuTemplate({ tabColor, actions }) {
  const colorItems = [
    { key: null, label: NO_TAB_COLOR_LABEL },
    ...Object.entries(TAB_COLOR_PRESETS).map(([key, preset]) => ({ key, label: preset.label })),
  ];

  return [
    {
      label: '色',
      submenu: colorItems.map(({ key, label }) => ({
        label,
        type: 'radio',
        checked: (tabColor || null) === key,
        click: () => actions.setColor(key),
      })),
    },
    { label: '名前を変更', click: actions.rename },
    { type: 'separator' },
    { label: '閉じる', click: actions.closeTab },
  ];
}

module.exports = { buildTerminalMenuTemplate, buildTabMenuTemplate };
