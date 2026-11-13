// themes.js — terminal appearance data + pure helpers. Dual-mode: attaches to
// window.SWARM_THEMES in the browser (loaded via <script> before renderer.js),
// and exports via module.exports under Node so test/themes.test.js can require it.
// NO DOM / xterm here — just data and validation, so it's unit-testable in Node.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_THEMES = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Each preset is a full xterm ITheme: the 4 core keys + 16 ANSI colors.
  // swarm-dark reproduces today's hardcoded look (its ANSI set is xterm's own
  // Tango defaults, which the app rendered before — so nothing shifts visually).
  const THEMES = [
    {
      id: 'swarm-dark', name: 'Svarmo Dark',
      xterm: {
        background: '#0d0f12', foreground: '#c9d1d9', cursor: '#3fd0c9',
        cursorAccent: '#0d0f12', selectionBackground: '#2b3640',
        black: '#2e3436', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000',
        blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
        brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234',
        brightYellow: '#fce94f', brightBlue: '#729fcf', brightMagenta: '#ad7fa8',
        brightCyan: '#34e2e2', brightWhite: '#eeeeec',
      },
    },
    {
      id: 'light', name: 'Light',
      xterm: {
        background: '#ffffff', foreground: '#24292e', cursor: '#044289',
        cursorAccent: '#ffffff', selectionBackground: '#c8e1ff',
        black: '#24292e', red: '#d73a49', green: '#22863a', yellow: '#b08800',
        blue: '#0366d6', magenta: '#6f42c1', cyan: '#1b7c83', white: '#6a737d',
        brightBlack: '#959da5', brightRed: '#cb2431', brightGreen: '#28a745',
        brightYellow: '#dbab09', brightBlue: '#2188ff', brightMagenta: '#8a63d2',
        brightCyan: '#3192aa', brightWhite: '#d1d5da',
      },
    },
    {
      id: 'solarized-dark', name: 'Solarized Dark',
      xterm: {
        background: '#002b36', foreground: '#839496', cursor: '#93a1a1',
        cursorAccent: '#002b36', selectionBackground: '#073642',
        black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
        blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
        brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#657b83',
        brightYellow: '#839496', brightBlue: '#93a1a1', brightMagenta: '#6c71c4',
        brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
      },
    },
    {
      id: 'dracula', name: 'Dracula',
      xterm: {
        background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2',
        cursorAccent: '#282a36', selectionBackground: '#44475a',
        black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
        blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
        brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
        brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
        brightCyan: '#a4ffff', brightWhite: '#ffffff',
      },
    },
    {
      id: 'nord', name: 'Nord',
      xterm: {
        background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9',
        cursorAccent: '#2e3440', selectionBackground: '#434c5e',
        black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
        blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
        brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c',
        brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead',
        brightCyan: '#8fbcbb', brightWhite: '#eceff4',
      },
    },
    {
      id: 'gruvbox-dark', name: 'Gruvbox Dark',
      xterm: {
        background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2',
        cursorAccent: '#282828', selectionBackground: '#504945',
        black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
        blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
        brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26',
        brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b',
        brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
      },
    },
  ];

  // Font stacks offered in the picker. Values are stored verbatim into
  // appearance.fontFamily and handed straight to xterm's fontFamily option.
  const FONT_FAMILIES = [
    { name: 'Системный моно', value: 'ui-monospace, "SF Mono", Menlo, monospace' },
    { name: 'Menlo', value: 'Menlo, monospace' },
    { name: 'Monaco', value: 'Monaco, monospace' },
    { name: 'JetBrains Mono', value: '"JetBrains Mono", ui-monospace, monospace' },
    { name: 'Courier', value: '"Courier New", Courier, monospace' },
  ];

  const CURSOR_STYLES = [
    { id: 'block', name: 'Блок' },
    { id: 'bar', name: 'Полоса' },
    { id: 'underline', name: 'Подчёркивание' },
  ];

  const DEFAULT_APPEARANCE = {
    theme: 'swarm-dark',
    fontSize: 13,
    fontFamily: FONT_FAMILIES[0].value,
    cursorStyle: 'block', // xterm's own default when unset — keeps today's look
    cursorBlink: true,
  };

  function getTheme(id) {
    return THEMES.find(function (t) { return t.id === id; }) || null;
  }

  // Coerce any stored/garbage value into a valid appearance object. Never throws.
  function normalizeAppearance(raw) {
    const d = DEFAULT_APPEARANCE;
    const r = (raw && typeof raw === 'object') ? raw : {};
    let fontSize = parseInt(r.fontSize, 10);
    if (!Number.isFinite(fontSize)) fontSize = d.fontSize;
    fontSize = Math.max(10, Math.min(20, fontSize));
    return {
      theme: getTheme(r.theme) ? r.theme : d.theme,
      fontSize: fontSize,
      fontFamily: (typeof r.fontFamily === 'string' && r.fontFamily.trim()) ? r.fontFamily : d.fontFamily,
      cursorStyle: ['block', 'bar', 'underline'].includes(r.cursorStyle) ? r.cursorStyle : d.cursorStyle,
      cursorBlink: typeof r.cursorBlink === 'boolean' ? r.cursorBlink : d.cursorBlink,
    };
  }

  return { THEMES, FONT_FAMILIES, CURSOR_STYLES, DEFAULT_APPEARANCE, getTheme, normalizeAppearance };
});
