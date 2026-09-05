// kanaterm - 配色・タブ色・フォントサイズのプリセット定義(main / renderer 共用)
//
// 同じ内容を main.js(メニューの選択肢)と renderer.js(実際の描画色)に
// 別々に持つと、片方だけ直したときに「メニューには出るが色が付かない」といった
// ずれが起きる。プリセットの定義はこのファイル1か所に集約する。
//
//   - mainプロセス側: require('./presets') で CommonJS として読み込む
//   - renderer側    : <script src="presets.js"> で読み込み、グローバル PRESETS を参照する
//     (contextIsolation下では require が使えないため、末尾の module 判定で分岐する)

// confirmMultilinePaste: 複数行を貼り付ける前に確認ダイアログを出すか。
//   シェルは改行を受け取った時点で行を実行してしまうため、既定は「確認する」。
// debugLog: 詳細ログ(DEBUG)を記録するか。既定はINFO以上のみ。
// captureScreen: 画面内容をファイルへ書き出すか(タブ状態の判定ロジックを作るための調査用)。
//   画面に見えている文字がそのまま残るため、既定は無効。
const DEFAULT_SETTINGS = {
  fontSize: 14,
  theme: 'dark',
  confirmMultilinePaste: true,
  debugLog: false,
  captureScreen: false,
};

const FONT_SIZE_PRESETS = [11, 14, 18, 22];

// label: メニューの表示名 / colors: xterm.js の theme にそのまま渡す値
const THEME_PRESETS = {
  dark: {
    label: 'ダーク(既定)',
    colors: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#585b70',
    },
  },
  light: {
    label: 'ライト',
    colors: {
      background: '#fafafa',
      foreground: '#1e1e2e',
      cursor: '#1e1e2e',
      selectionBackground: '#c6c6c6',
    },
  },
  'high-contrast': {
    label: 'ハイコントラスト',
    colors: {
      background: '#000000',
      foreground: '#ffffff',
      cursor: '#ffffff',
      selectionBackground: '#666666',
    },
  },
  navy: {
    label: '紺',
    colors: {
      background: '#0d1b3e',
      foreground: '#dbe4ff',
      cursor: '#dbe4ff',
      selectionBackground: '#2c3e6b',
    },
  },
  green: {
    label: '緑',
    colors: {
      background: '#0d2b1a',
      foreground: '#d7f5df',
      cursor: '#d7f5df',
      selectionBackground: '#1f5c39',
    },
  },
  'dark-red': {
    label: '濃赤',
    colors: {
      background: '#3a0d12',
      foreground: '#f7dede',
      cursor: '#f7dede',
      selectionBackground: '#6b1f28',
    },
  },
};

// タブごとの色分け。タブ行の背景色に使うので、文字が読めるよう暗めの色調にしてある。
// 「色なし」は null で表し、この表には含めない。
const TAB_COLOR_PRESETS = {
  red: { label: '赤', swatch: '#4d2430' },
  orange: { label: '橙', swatch: '#4d3524' },
  yellow: { label: '黄', swatch: '#4d4624' },
  green: { label: '緑', swatch: '#254d31' },
  blue: { label: '青', swatch: '#243a4d' },
  purple: { label: '紫', swatch: '#39244d' },
  gray: { label: 'グレー', swatch: '#33353d' },
};

const NO_TAB_COLOR_LABEL = '(なし)';

/** 未知のキーが保存されていても既定値へ落として壊れないようにする */
function themeColors(themeKey) {
  return (THEME_PRESETS[themeKey] || THEME_PRESETS.dark).colors;
}

/** color が null / 未知のキーなら空文字(=色指定なし)を返す */
function tabSwatch(color) {
  return (color && TAB_COLOR_PRESETS[color] && TAB_COLOR_PRESETS[color].swatch) || '';
}

const PRESETS = {
  DEFAULT_SETTINGS,
  FONT_SIZE_PRESETS,
  THEME_PRESETS,
  TAB_COLOR_PRESETS,
  NO_TAB_COLOR_LABEL,
  themeColors,
  tabSwatch,
};

if (typeof module !== 'undefined' && module.exports) module.exports = PRESETS;
