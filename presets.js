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

// サイドバーで使う色。タブの色分けと状態の●が、ここから同じ表を引く。
//
// 以前はタブ行の背景そのものを色にしていたが、その上に文字を読ませる都合で
// 色を暗く抑えるしかなく、「広い面積 × 弱い色」になっていた。今は色を左端の
// 細い帯に載せるので、文字の読みやすさと無関係に彩度を上げられる。
//
// 明るい配色では、暗い地の上で映える淡い色がそのままでは沈む。逆もまた同じ。
// そこで同じ色名で2組持ち、配色ごとにどちらを使うかを選ぶ。
const UI_COLOR_SETS = {
  // 暗い地の上（ダーク・紺・緑・濃赤・ハイコントラスト）
  dark: {
    red: '#f38ba8',
    orange: '#fab387',
    yellow: '#f9e2af',
    green: '#a6e3a1',
    blue: '#89b4fa',
    purple: '#cba6f7',
    gray: '#9399b2',
    dim: '#585b70', // 状態の●の既定(claude未実行)。タブの色分けには出てこない
  },
  // 明るい地の上（ライト）
  light: {
    red: '#d20f39',
    orange: '#fe640b',
    yellow: '#df8e1d',
    green: '#40a02b',
    blue: '#1e66f5',
    purple: '#8839ef',
    gray: '#6c6f85',
    dim: '#9ca0b0',
  },
};

// label   : メニューの表示名
// colors  : xterm.js の theme にそのまま渡す値
// ui      : サイドバー(タブ一覧)側の色。端末だけ配色が変わってサイドバーが
//           取り残されると、明るい配色を選んだときに画面が半端に見えるため、
//           配色ごとに揃えて持つ。
// colorSet: タブの帯と状態の●に、UI_COLOR_SETS のどちらを使うか
const THEME_PRESETS = {
  dark: {
    label: 'ダーク(既定)',
    colors: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#585b70',
    },
    colorSet: 'dark',
    ui: {
      sidebar: '#181825',
      sidebarActive: '#313244',
      sidebarHover: '#262637',
      border: '#313244',
      text: '#cdd6f4',
      inputBg: '#313244',
      inputBorder: '#585b70',
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
    colorSet: 'light',
    ui: {
      sidebar: '#ececec',
      sidebarActive: '#d4d4d4',
      sidebarHover: '#e0e0e0',
      border: '#cfcfcf',
      text: '#1e1e2e',
      inputBg: '#ffffff',
      inputBorder: '#9ca0b0',
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
    colorSet: 'dark',
    ui: {
      sidebar: '#000000',
      sidebarActive: '#333333',
      sidebarHover: '#1a1a1a',
      border: '#666666',
      text: '#ffffff',
      inputBg: '#000000',
      inputBorder: '#ffffff',
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
    colorSet: 'dark',
    ui: {
      sidebar: '#091531',
      sidebarActive: '#1e3568',
      sidebarHover: '#132348',
      border: '#1e3568',
      text: '#dbe4ff',
      inputBg: '#1e3568',
      inputBorder: '#4a63a0',
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
    colorSet: 'dark',
    ui: {
      sidebar: '#092013',
      sidebarActive: '#1f5c39',
      sidebarHover: '#123322',
      border: '#1f5c39',
      text: '#d7f5df',
      inputBg: '#1f5c39',
      inputBorder: '#4a8f66',
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
    colorSet: 'dark',
    ui: {
      sidebar: '#2c090e',
      sidebarActive: '#6b1f28',
      sidebarHover: '#421318',
      border: '#6b1f28',
      text: '#f7dede',
      inputBg: '#6b1f28',
      inputBorder: '#a04a55',
    },
  },
};

// タブごとの色分け。実際の色は UI_COLOR_SETS が持ち、ここはキーと表示名だけ。
// 色の値を1か所にまとめておかないと、配色を増やしたときに拾い漏れる。
// 「色なし」は null で表し、この表には含めない。
const TAB_COLOR_PRESETS = {
  red: { label: '赤' },
  orange: { label: '橙' },
  yellow: { label: '黄' },
  green: { label: '緑' },
  blue: { label: '青' },
  purple: { label: '紫' },
  gray: { label: 'グレー' },
};

const NO_TAB_COLOR_LABEL = '(なし)';

/** 未知のキーが保存されていても既定値へ落として壊れないようにする */
function theme(themeKey) {
  return THEME_PRESETS[themeKey] || THEME_PRESETS.dark;
}

function themeColors(themeKey) {
  return theme(themeKey).colors;
}

/** サイドバー側の色一式(CSS変数へそのまま流す) */
function themeUi(themeKey) {
  return theme(themeKey).ui;
}

/** その配色で使う色の組(タブの帯と状態の●が共用する) */
function colorSet(themeKey) {
  return UI_COLOR_SETS[theme(themeKey).colorSet] || UI_COLOR_SETS.dark;
}

/** タブ左端の帯の色。color が null / 未知のキーなら空文字(=色指定なし) */
function tabBarColor(color, themeKey) {
  if (!color || !TAB_COLOR_PRESETS[color]) return '';
  return colorSet(themeKey)[color] || '';
}

const PRESETS = {
  DEFAULT_SETTINGS,
  FONT_SIZE_PRESETS,
  THEME_PRESETS,
  TAB_COLOR_PRESETS,
  UI_COLOR_SETS,
  NO_TAB_COLOR_LABEL,
  themeColors,
  themeUi,
  colorSet,
  tabBarColor,
};

if (typeof module !== 'undefined' && module.exports) module.exports = PRESETS;
