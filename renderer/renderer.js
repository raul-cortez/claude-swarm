// renderer.js — UI logic. Runs in the sandboxed renderer, talks to main ONLY
// through window.swarm (see preload.js). No Node here.
//
// Model: one entry per session, each owning its own xterm instance + a DOM
// holder. Only the active holder is visible; the others stay mounted so their
// scrollback survives when you switch tabs.

const { Terminal } = window;                 // UMD global from xterm.js
const { FitAddon } = window.FitAddon;        // UMD global from addon-fit

// --- error capture (set up FIRST, before any risky init) ---------------------
// Runtime errors go into a ring buffer surfaced behind the red "!" in the status
// bar; clicking it opens a copyable log modal. The indicator + its click handler
// are wired here, at the very top, so that even a crash DURING load (which would
// stop the listener wiring at the end of this file from ever running) is still
// recorded AND the "!" stays clickable — exactly the case we want to diagnose.
const logStore = window.SWARM_LOGSTORE.createLogStore(200);

function nowClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Значок в статусной строке живёт в трёх состояниях: пусто — его нет; есть
// непрочитанные ошибки — красный со счётчиком; всё прочитано — серый «!», чтобы лог
// оставался доступен, но не кричал. Совсем убрать его можно кнопкой «Очистить» в
// самом логе.
function updateLogIndicator() {
  const btn = document.getElementById('log-indicator');
  if (!btn) return;
  const total = logStore.errorCount();
  const fresh = logStore.unseenCount();
  btn.hidden = total === 0;
  btn.classList.toggle('quiet', fresh === 0);
  btn.textContent = fresh === 0 ? '!' : (fresh > 99 ? '! 99+' : '! ' + fresh);
  btn.title = fresh === 0
    ? 'Логи ошибок — новых нет'
    : (fresh === 1 ? 'Новая ошибка — показать логи' : `Новых ошибок: ${fresh} — показать логи`);
}

function recordLog(source, level, msg) {
  logStore.push({ ts: nowClock(), source, level, msg });
  updateLogIndicator();
}

function openLogsModal() {
  if (document.querySelector('.modal-overlay .modal.logs')) return; // already open
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal logs">
      <div class="modal-title">Логи ошибок</div>
      <div class="logs-body"></div>
      <div class="modal-actions">
        <button class="modal-cancel logs-close">Закрыть</button>
        <button class="modal-cancel logs-clear">Очистить</button>
        <button class="modal-ok neutral logs-copy">Скопировать</button>
      </div>
    </div>`;
  const body = overlay.querySelector('.logs-body');
  const entries = logStore.entries();
  if (!entries.length) {
    body.innerHTML = '<div class="logs-empty">Пусто — ошибок не было.</div>';
  } else {
    for (const e of entries) {
      const row = document.createElement('div');
      row.className = 'logs-row level-' + e.level;
      const meta = document.createElement('span');
      meta.className = 'logs-meta';
      meta.textContent = `${e.ts} · ${e.source} · ${e.level}`;
      const msg = document.createElement('div');
      msg.className = 'logs-msg';
      msg.textContent = e.msg;               // textContent — never render captured text as markup
      row.append(meta, msg);
      body.appendChild(row);
    }
  }
  document.body.appendChild(overlay);
  if (entries.length) body.scrollTop = body.scrollHeight; // newest at the bottom
  // Открыл лог — значит увидел: счётчик гаснет, значок становится серым.
  logStore.markSeen();
  updateLogIndicator();
  const close = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  overlay.querySelector('.logs-close').addEventListener('click', close);
  overlay.querySelector('.logs-clear').addEventListener('click', () => {
    logStore.clear();
    updateLogIndicator();
    close();
  });
  overlay.querySelector('.logs-copy').addEventListener('click', () => {
    try { window.swarm.clipboardWrite(logStore.text()); } catch (_) {}
  });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
}

(function initErrorCapture() {
  const btn = document.getElementById('log-indicator');
  if (btn) btn.addEventListener('click', openLogsModal);
  const safeStringify = (o) => { try { return JSON.stringify(o); } catch (_) { return String(o); } };
  const fmt = (a) => (a && a.stack) || (typeof a === 'object' ? safeStringify(a) : String(a));
  window.addEventListener('error', (e) => {
    recordLog('ui', 'error', (e.error && e.error.stack) || e.message || 'ошибка');
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    recordLog('ui', 'error', (r && r.stack) || (r && r.message) || String(r));
  });
  const wrap = (level, orig) => (...args) => {
    try { recordLog('ui', level, args.map(fmt).join(' ')); } catch (_) { /* never let logging throw */ }
    orig.apply(console, args);
  };
  console.error = wrap('error', console.error.bind(console));
  console.warn = wrap('warn', console.warn.bind(console));
  try {
    window.swarm.onAppError((entry) => {
      logStore.push({
        ts: (entry && entry.ts) || nowClock(),
        source: 'main',
        level: (entry && entry.level) || 'error',
        msg: (entry && entry.msg) || '',
      });
      updateLogIndicator();
    });
  } catch (_) { /* preload without onAppError — ignore */ }
})();

const APPEARANCE = window.SWARM_THEMES;       // terminal theme presets + helpers
const KEYBINDS_API = window.SWARM_KEYBINDS;   // newline chord + word/line scopes
const RESUME_API = window.SWARM_RESUME;       // Claude -n / --resume per tab
const TABSTYLE = window.SWARM_TABSTYLE;       // tab card density / visibility / colors
const RESTART_API = window.SWARM_RESTART;     // самоперезапуск: границы порога, общие с main
const TERMTALK = window.SWARM_TERMTALK;      // речь терминала (мышь, ответы) — не печать человека

// Global terminal appearance (theme + font + cursor). One setting for all tabs,
// persisted as a single JSON blob in localStorage (see swarm.appearance). Read by
// makeXterm() for NEW tabs and by applyAppearance() to restyle LIVE tabs on save.
let appearance = loadAppearance();

function loadAppearance() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem('swarm.appearance') || 'null'); } catch (_) {}
  return APPEARANCE.normalizeAppearance(raw);
}

function saveAppearance() {
  localStorage.setItem('swarm.appearance', JSON.stringify(appearance));
}

// Tab card look (density, which elements show, font sizes, status colors). One
// setting for all tabs, persisted as a single JSON blob in swarm.tabstyle —
// separate from swarm.appearance, which describes the TERMINAL, not the chrome.
let tabstyle = loadTabStyle();

function loadTabStyle() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem('swarm.tabstyle') || 'null'); } catch (_) {}
  return TABSTYLE.normalizeTabStyle(raw);
}

function saveTabStyle() {
  localStorage.setItem('swarm.tabstyle', JSON.stringify(tabstyle));
}

// Custom keybinds (newline chord + word/line scope modifiers). Handlers read this
// live object, so Save in Settings takes effect without recreating terminals.
let keybinds = loadKeybinds();

function loadKeybinds() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem('swarm.keybinds') || 'null'); } catch (_) {}
  const next = KEYBINDS_API.normalizeKeybinds(raw, window.swarm.platform);
  // Persist mac→win / legacy→scope migration so Settings / next launch see new shape.
  try {
    if (JSON.stringify(raw) !== JSON.stringify(next)) {
      localStorage.setItem('swarm.keybinds', JSON.stringify(next));
    }
  } catch (_) {}
  return next;
}

function saveKeybinds() {
  localStorage.setItem('swarm.keybinds', JSON.stringify(keybinds));
}

// Restyle every LIVE terminal in place, then refit — a font-size change alters the
// cell grid, so the pty must be resized (same reason applyLayout refits).
function applyAppearance() {
  const xt = APPEARANCE.getTheme(appearance.theme).xterm;
  for (const s of sessions.values()) {
    s.term.options.theme = xt;
    s.term.options.fontSize = appearance.fontSize;
    s.term.options.fontFamily = appearance.fontFamily;
    s.term.options.cursorStyle = appearance.cursorStyle;
    s.term.options.cursorBlink = appearance.cursorBlink;
    s.fit.fit();
  }
}

// Every class bodyClasses() can produce — listed so apply can clear the previous
// state without touching layout-* / platform-* on the same element.
const TABSTYLE_CLASSES = [
  'tabs-compact', 'tabs-normal', 'tabs-roomy',
  'tab-no-dot', 'tab-no-ctx', 'tab-no-sub', 'tab-no-fill',
];

// Restyle every tab card at once: vars on <html>, classes on <body>. No DOM
// rebuild — the effect is pure cascade, so live and future cards both pick it up.
// No fit() here, unlike applyAppearance: the chrome's height is flexbox-driven and
// the #stage ResizeObserver (see below) refits the terminal when the bar changes.
function applyTabStyle() {
  const vars = TABSTYLE.toCssVars(tabstyle);
  for (const k of Object.keys(vars)) document.documentElement.style.setProperty(k, vars[k]);
  document.body.classList.remove(...TABSTYLE_CLASSES);
  document.body.classList.add(...TABSTYLE.bodyClasses(tabstyle));
}

// Tag the body with the host OS so the stylesheet can drop mac-only chrome
// (the empty gaps reserved for the traffic lights) on Windows/Linux.
document.body.classList.add('platform-' + (window.swarm.platform || 'unknown'));

const tabsEl     = document.getElementById('tabs');
const stageEl    = document.getElementById('stage');
const newTabBtn  = document.getElementById('new-session-folder');
const cmdBtn     = document.getElementById('cmd-menu-btn');
const cmdMenu    = document.getElementById('cmd-menu');
const launchMenu = document.getElementById('launch-menu');
const gitBtn      = document.getElementById('git-branch');
const gitMenu     = document.getElementById('git-menu');
const gitMsgEl    = document.getElementById('git-msg');
const gitDiffBtn  = document.getElementById('git-diff');

let gitInfo = null;      // last git:info for the ACTIVE folder (null until first fetch)
let gitMsgTimer = null;  // auto-clear timer for the transient error plaque
let gitDiff = null;      // last git:diffstat for the ACTIVE folder (null until first fetch)
let gitDiffBusy = false; // a diffstat is in flight — skip the tick, don't queue up

// Built-in commands sent into the ACTIVE session on click, grouped by purpose.
// Item flags (all optional):
//   confirm — show a modal first (destructive commands like /clear)
//   arg     — command needs an argument: we type "cmd " (no Enter) and focus the
//             terminal so you finish typing it yourself (keeps Claude's own
//             argument autocomplete). Without arg, we send "cmd\r" to run now.
// Project/global custom commands are auto-discovered separately (see openCmdMenu).
const BUILTIN_GROUPS = [
  {
    title: 'контекст',
    items: [
      { name: '/compact', hint: 'сжать историю' },
      { name: '/context', hint: 'показать контекст' },
      { name: '/clear', hint: 'очистить контекст', confirm: 'Очистить весь контекст активного агента? История разговора будет стёрта безвозвратно.' },
    ],
  },
  {
    title: 'расход',
    items: [
      { name: '/cost', hint: 'расход токенов' },
      { name: '/usage', hint: 'лимиты плана' },
    ],
  },
  {
    title: 'сессия',
    items: [
      { name: '/model', hint: 'сменить модель' },
      { name: '/resume', hint: 'вернуться к диалогу' },
    ],
  },
];

// Inline Lucide icons (MIT) — no dependency/bundler needed. currentColor-styled.
const SVG = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
  plus: SVG('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  command: SVG('<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>'),
  folder: SVG('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>'),
  chevron: SVG('<path d="m6 9 6 6 6-6"/>'),
  branch: SVG('<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'),
  gear: SVG('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  // Lucide "grip-vertical" — the drag handle on a card / folder header.
  grip: SVG('<circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>'),
  // Lucide "bot" — the sub-agent badge.
  agents: SVG('<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>'),
  // Lucide "monitor" / "smartphone" — «где я сейчас»: за столом или с одним телефоном.
  monitor: SVG('<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>'),
  phone: SVG('<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>'),
  moon: SVG('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'),
  // Lucide "x" — закрыть вкладку. Рисованный, а не литера «×»: рядом с луной в одной
  // капсуле знак из шрифта заметно тяжелее и стоит не по центру круга.
  close: SVG('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  sunrise: SVG('<path d="M12 2v6"/><path d="m4.93 8.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m17.66 10.34 1.41-1.41"/><path d="M22 22H2"/><path d="m8 6 4-4 4 4"/><path d="M16 18a4 4 0 0 0-8 0"/>'),
};

// Кнопки карточки — луна и крестик — одной капсулой в правом верхнем углу. Разметка общая с
// превью настроек: карточка в настройках должна быть той же карточкой, а не похожей на неё.
function tabTools() {
  return `<span class="tools"><span class="moon" title="Ночной режим: пусть работает без вас" aria-pressed="false">${ICONS.moon}</span><span class="t-sep"></span><span class="close" title="Закрыть вкладку">${ICONS.close}</span></span>`;
}

// Put an icon + a folder name into an element (name via text node, never markup).
function setFolderLabel(el, name) {
  el.innerHTML = ICONS.folder;
  el.appendChild(document.createTextNode(' ' + name));
}

/** id -> { term, fit, holder, tab, alive, status, idleTimer } */
const sessions = new Map();
let activeId = null;
// --- pult --------------------------------------------------------------------
// A pinned tab (⌘0) that lists every agent waiting on an answer and shows the
// live terminal of the picked one. Not a session: it has no pty. See
// docs/superpowers/specs/2026-07-15-pult-design.md.
let pultEnabled = localStorage.getItem('swarm.pult') !== '0'; // Settings → Вид
let pultOn = false;      // pult mode active right now
let pultPick = null;     // id of the agent whose terminal the pult shows
let pultTimer = null;    // 1s tick, only while pultOn — chips show a live timer
// The pult can change pultPick two ways: because YOU picked a chip / opened it,
// or because the queue advanced on its own after you answered someone. Only the
// second one is a surprise, so only it gets the handoff cue below.
let pultPickManual = false; // set right before renderPult() by a user gesture
let pultFlashAt = 0;        // Date.now() of the running handoff cue (0 = none)
let pultFlashTimer = null;
const PULT_FLASH_MS = 1200; // keep in sync with the CSS animations
let renaming = false;       // true while a card title is being edited (don't steal focus)
let notifyEnabled = true;   // master switch: system notifications for background agents
// Finer notification prefs (all default on), editable in Settings → Уведомления.
let notifySound = localStorage.getItem('swarm.notifySound') !== '0';   // play a sound
let notifyOnReady = localStorage.getItem('swarm.notifyReady') !== '0';   // ping on «готов»
let notifyOnWaiting = localStorage.getItem('swarm.notifyWaiting') !== '0'; // ping on «ждёт ответа»
// Off by default: normally the tab you're actively watching in a focused window
// isn't pinged (it'd be noise). Turn on to get pings for it too.
let notifyActive = localStorage.getItem('swarm.notifyActive') !== '0';
let lastFolder = null;      // last folder picked, so the dialog reopens there
const collapsedFolders = new Set(); // folders whose group is collapsed in the sidebar
const folderOrder = [];             // cwd keys in display order (folders + loners)
const withinOrder = new Map();      // cwd -> [session id, …] in display order
let drag = null;                    // active drag: { kind: 'card'|'unit', id?, cwd }
let dropped = false;                // whether the current drag committed a drop

// --- status ------------------------------------------------------------------
// Status is inferred from the pty stream in main.js (see the detector there)
// and pushed over onStatus. The renderer just paints it: `status` drives the
// color class, `detail` the subline text ("Baking… · 385 ток", "завис? 9с", …).
function setStatus(id, status, detail) {
  const s = sessions.get(id);
  if (!s) return;
  if (status && s.status !== status) {
    if (STATUS_DEBUG) console.debug('[status] paint', statusName(s), s.status, '→', status, '| raw:', s.rawStatus, 'sub:', s.sub);
    s.status = status;
    s.tab.classList.remove('status-ready', 'status-running', 'status-waiting', 'status-dead');
    s.tab.classList.add('status-' + status);
    if (s.sumDot) s.sumDot.className = 'sum-dot status-' + status; // collapsed-group dot
    // Queue order + chip timer in the pult: when this agent started waiting.
    s.waitingSince = status === 'waiting' ? Date.now() : null;
    // Подпись «вопрос»/«разрешение» — часть жёлтого состояния и снимается вместе с ним. Пока
    // вкладка жёлтая, стереть её не может никто (см. onStatus): иначе дребезг статуса в main,
    // которого на вкладке не видно — цвет держат буферы, — проступал бы миганием подписи.
    if (status !== 'waiting') s.waitKind = null;
    renderPult();
  }
  if (detail != null) {
    const sub = s.tab.querySelector('.sub');
    if (sub) sub.textContent = detail;
  }
}

// --- one shared subscription for pty output; route by id ---------------------
window.swarm.onData(({ id, data }) => {
  const s = sessions.get(id);
  if (s) s.term.write(data);
});

// The tab moved to another Claude conversation — /clear, a `claude` typed by hand, a
// /resume inside the terminal. Main learns the new id from the hook marker; we save it,
// so «восстанавливать диалоги» reopens what you were actually in, not what we launched.
window.swarm.onClaudeSession(({ id, claudeSessionId }) => {
  const s = sessions.get(id);
  if (!s || (s.claudeSessionId || null) === (claudeSessionId || null)) return;
  s.claudeSessionId = claudeSessionId || null;
  persistTabs();
});

// Inferred status from main (running / ready / waiting + detail + context fill).
const RUN_BUFFER_MS = 2500; // delay painting "работает" so sub-buffer blips never show
// Leaving «ждёт» is held separately (and shorter): its job is only to keep the Пульт
// queue steady through a repaint blip while you read the question — main already
// debounces the real release. It used to be RUN_BUFFER_MS and then STACKED with it,
// so answering a prompt left the tab «ждёт» for up to five seconds.
const LEAVE_WAIT_MS = 1200;
// …и держать нечего, когда из «ждёт» вывел ТЫ САМ: ты только что нажал Enter в этой вкладке,
// значит уход из ожидания настоящий, а не блик перекраса. Без этого вкладка ещё секунду с
// лишним висела «ждёт ответа» после твоего же ответа — ровно то, что видно глазами.
const SELF_ANSWER_MS = 3000;
function answeredHere(s) {
  return !!(s && s.answeredAt) && Date.now() - s.answeredAt < SELF_ANSWER_MS;
}

// Диагностика перекраса вкладок: включить в devtools-консоли `swarmStatusDebug(true)`
// (сохраняется в localStorage). Логирует и входящий поток статусов из main, и
// каждый фактический перекрас — чтобы поймать, что держит вкладку «зелёной».
let STATUS_DEBUG = false;
try { STATUS_DEBUG = localStorage.getItem('swarm.statusDebug') === '1'; } catch (_) {}
window.swarmStatusDebug = (on) => {
  STATUS_DEBUG = !!on;
  try { localStorage.setItem('swarm.statusDebug', on ? '1' : '0'); } catch (_) {}
  console.info('[status] debug', STATUS_DEBUG ? 'ON' : 'OFF');
};
function statusName(s) {
  const el = s.tab && s.tab.querySelector('.label');
  return (el && el.textContent) || s.id;
}

// WHY a waiting agent is calling — for the chip, tab sub-label and notify. null =>
// the generic «ждёт ответа» (detector wasn't confident, or hooks haven't spoken).
const KIND_LABEL = { permission: 'разрешение', question: 'вопрос' };
function waitLabel(s) { return KIND_LABEL[s && s.waitKind] || 'ждёт ответа'; }

window.swarm.onStatus(({ id, status, detail, ctxPct, question, sub, waitingKind, sure, done }) => {
  const s = sessions.get(id);
  if (!s || !s.alive) return;

  if (STATUS_DEBUG) console.debug('[status] ← main', statusName(s), 'raw:', status, 'detail:', detail, 'shown:', s.status);

  if (ctxPct !== undefined) { s.ctxPct = ctxPct; updateCtx(s); }
  if (question !== s.question) { s.question = question; renderPult(); }
  // Пустой kind приходит с ЛЮБЫМ не-ждущим статусом, а вкладка в этот миг может быть ещё
  // жёлтой: уход из «ждёт» дебаунсится, «работает» буферизуется (см. applyStatus). Затирать
  // им подпись значит показывать «ждёт ответа» вместо «вопрос» на каждом таком такте — ровно
  // это и мигало на вкладке с работающим подагентом. Снимет подпись setStatus, когда вкладка
  // и правда перестанет быть жёлтой.
  const kind = waitingKind || null;
  if (kind !== (s.waitKind || null) && (kind || s.status !== 'waiting')) {
    s.waitKind = kind;
    renderPult();
    // Sharpening (question → permission) can arrive while status stays «waiting»,
    // so refresh the sub-label directly — applyStatus only repaints on transitions.
    if (s.status === 'waiting') { const subEl = s.tab.querySelector('.sub'); if (subEl) subEl.textContent = waitLabel(s); }
  }
  if ((sub || 0) !== (s.sub || 0)) { s.sub = sub || 0; updateAgents(s); }

  // Keep the RAW main-thread status; the tab's shown status may differ from it —
  // see effectiveStatus (the «оранжевый пока работает сабагент» toggle).
  s.rawStatus = status;
  s.rawDetail = detail;
  // Пришло это от хука/стенограммы (факт) или со скрёба экрана (догадка) — от этого
  // зависит, буферизуем ли «работает». См. applyStatus.
  s.sure = !!sure;
  // Вкладка сдала работу — своими словами, тегом конца задачи. Днём это ничего не меняет
  // (зелёная вкладка и так значит «свободна»), а вот у отданной вкладки это единственное
  // отличие «работает без меня» от «отработала»: см. paintAuto.
  if (!!done !== !!s.done) { s.done = !!done; paintAuto(s); }
  applyStatus(s, { notify: true });
  // Плашка владения называет и то, чего вкладка ждёт: пока она просит разрешение, нажатия
  // в неё уходят (см. autoNow), и человек должен видеть, что это не поломка.
  if (id === activeId) renderGate();
});

// The status a tab should SHOW = the main-thread status, except: while sub-agents
// run in the background the main thread often sits idle («готов»/green), yet the
// work isn't done — so we keep it «работает». A real prompt (waiting) always wins
// so the user still notices.
//
// Раньше это была галочка в настройках, и она ушла: зелёная вкладка означает
// «свободна, дай задачу», так что выключить это значило договориться с собой, что
// карточка будет врать. У настройки было одно правильное положение.
function effectiveStatus(s) {
  const status = s.rawStatus || s.status || 'ready';
  const detail = s.rawDetail != null ? s.rawDetail : null;
  if ((s.sub || 0) > 0 && status === 'ready') {
    return { status: 'running', detail: 'работает' };
  }
  return { status, detail };
}

// Paint the effective status. `running` is buffered by RUN_BUFFER_MS so sub-buffer
// blips never flash orange; `ready`/`waiting` apply immediately. Notifications fire
// only on real IPC transitions (opts.notify), never on a settings re-apply.
function applyStatus(s, opts) {
  const eff = effectiveStatus(s);
  // Уход из «ждёт» уже подтверждён: либо мы отстояли LEAVE_WAIT_MS, либо ты сам ответил в
  // этой вкладке. И то и другое означает «буферизовать больше нечего» — ни здесь, ни ниже
  // на пути в «работает».
  const leaveWait = !!(opts && opts.leaveWait) || answeredHere(s);

  // Уход из waiting дебаунсим: короткий блик в ready/running, пока читаешь вопрос,
  // не должен выкидывать сессию из очереди Пульта и перематывать выбор. Возврат в
  // waiting отменяет отложенный уход — waitingSince сохраняется, порядок стабилен.
  // (Это НЕ лечит долгий перекрас из main — только стабилизирует очередь.)
  if (eff.status === 'waiting') {
    if (s.leaveWaitTimer) { clearTimeout(s.leaveWaitTimer); s.leaveWaitTimer = null; }
  } else if (s.status === 'waiting' && !leaveWait) {
    if (!s.leaveWaitTimer) {
      s.leaveWaitTimer = setTimeout(() => {
        s.leaveWaitTimer = null;
        if (s.alive) applyStatus(s, { leaveWait: true, notify: true });
      }, LEAVE_WAIT_MS);
    }
    return; // держим waiting, вкладку не трогаем
  }

  if (eff.status === 'running') {
    if (s.runningSince == null) s.runningSince = Date.now(); // real start of this run
    if (s.status === 'running') return;
    // Буфер существует, чтобы не мигать жёлтым на КОРОТКИХ ВСПЛЕСКАХ, которые
    // померещились скрёбу экрана. Значит и придерживать надо только его догадки.
    //
    // `s.sure` — статус пришёл от хука (UserPromptSubmit: «промпт отправлен») или из
    // стенограммы (в файле новая реплика). Это события, а не наблюдения, мигать им
    // нечем. `answeredHere` — ты сам нажал Enter в этой вкладке; факт того же рода, и
    // он выручает сессии без хуков, где сигнал придёт с экрана.
    //
    // Без этого любой «готов» красился мгновенно, а возврат в «работает» ждал 2.5 с, и
    // вкладка две с половиной секунды после отправки сообщения стояла зелёной — будто
    // статус сначала загорелся не тем, а потом «актуализировался».
    if (leaveWait && s.status === 'waiting') {
      // Coming out of «ждёт»: we already held the tab for LEAVE_WAIT_MS, which IS
      // the anti-blip buffer. Stacking RUN_BUFFER_MS on top of it was the lag
      // between answering a prompt and the tab finally turning «работает».
      if (s.runTimer) { clearTimeout(s.runTimer); s.runTimer = null; }
      setStatus(s.id, 'running', eff.detail);
      return;
    }
    if (s.sure || answeredHere(s)) {
      if (s.runTimer) { clearTimeout(s.runTimer); s.runTimer = null; }
      setStatus(s.id, 'running', eff.detail);
      return;
    }
    if (!s.runTimer) {
      s.runTimer = setTimeout(() => {
        s.runTimer = null;
        if (s.alive) setStatus(s.id, 'running', eff.detail);
      }, RUN_BUFFER_MS);
    }
    return; // notifications only fire on the ready/waiting transitions below
  }
  // ready / waiting: cancel any pending orange, then apply immediately.
  if (s.runTimer) { clearTimeout(s.runTimer); s.runTimer = null; }
  const prev = s.status;
  setStatus(s.id, eff.status, eff.status === 'waiting' ? waitLabel(s) : eff.detail);
  if (opts && opts.notify) maybeNotify(s.id, prev, eff.status);
  s.runningSince = null;
}

// The sub-agent badge (icon + count). Number shows only when >1 (a single agent is
// just the icon). Показывать значок или нет, больше не спрашиваем: он и так виден
// только пока сабагенты работают, так что галочке было нечего выключать.
function updateAgents(s) {
  const el = s.tab.querySelector('.agents');
  if (!el) return;
  const n = s.sub || 0;
  if (n <= 0) { el.hidden = true; return; }
  el.hidden = false;
  const num = el.querySelector('.agents-num');
  if (num) num.textContent = n > 1 ? String(n) : '';
}

// Заполнение контекста на карточке вкладки. Число приходит готовым из main (ctxFillOf):
// точное, от самого Клода. Разбирать процент из строки статуса здесь больше нельзя —
// в неё попадает проза агента, и полоска показывала «80%» от фразы про загрузку
// процессора, пока контекста было занято 15%.
function updateCtx(s) {
  const ctx = s.tab.querySelector('.ctx');
  const pct = Number(s.ctxPct);
  if (s.ctxPct == null || !isFinite(pct)) { ctx.hidden = true; return; }
  const val = Math.max(0, Math.min(100, Math.round(pct)));
  ctx.hidden = false;
  ctx.querySelector('.ctx-fill').style.width = val + '%';
  ctx.querySelector('.ctx-num').textContent = val + '%';
  ctx.classList.remove('ctx-lo', 'ctx-mid', 'ctx-hi');
  ctx.classList.add(val < 50 ? 'ctx-lo' : val < 80 ? 'ctx-mid' : 'ctx-hi');
}

window.swarm.onExit(({ id }) => {
  const s = sessions.get(id);
  if (!s) return;
  s.alive = false;
  // Мандат умер вместе с агентом: main его уже снял (tgOnTabGone), и держать отметку здесь
  // значило бы считать мёртвую вкладку работающей — значок «N вкладок сами» висел бы, а клик по
  // нему ничего не менял (main вернул бы «и так снято»).
  if (s.auto) applyTabAuto(id, false);
  if (s.runTimer) { clearTimeout(s.runTimer); s.runTimer = null; }
  if (s.leaveWaitTimer) { clearTimeout(s.leaveWaitTimer); s.leaveWaitTimer = null; }
  setStatus(id, 'dead', 'завершён');
  // Claude/the shell has exited. Leave the pane so output stays readable.
  s.term.write('\r\n\x1b[2m[session ended — close the tab]\x1b[0m\r\n');
});

// Terminal links open only on modifier-click (like VS Code / editors), so a
// stray click while reading never yanks you to the browser. macOS uses ⌘, the
// rest use Ctrl. The hover tooltip spells this out.
// Одно место на все подписи, где упоминается система. Приложение собирается и под Windows,
// поэтому «⌘», «мак» и «~/.zshrc» в тексте — это обещание клавиши и файла, которых там нет.
const MAC = window.swarm.platform === 'darwin';
const key = (k) => (MAC ? '⌘' + k : 'Ctrl+' + k);
const HOST = {
  fileManager: MAC ? 'Finder' : 'Проводника',
  profile: MAC ? '<code>~/.zshrc</code>' : 'профиля PowerShell',
  exports: MAC ? 'пропишите нужные <code>export</code> в <code>~/.zshrc</code>'
    : 'задайте переменные окружения — <code>setx</code> или профиль PowerShell',
};

const LINK_MOD = window.swarm.platform === 'darwin' ? 'metaKey' : 'ctrlKey';
const LINK_HINT = window.swarm.platform === 'darwin'
  ? '⌘+клик — открыть ссылку'
  : 'Ctrl+клик — открыть ссылку';

// One reused tooltip element, positioned once where the cursor enters a link
// (the addon fires `hover` on entry, not per mouse-move).
let linkTip = null;
function showLinkTip(event) {
  if (!linkTip) {
    linkTip = document.createElement('div');
    linkTip.className = 'link-tip';
    linkTip.textContent = LINK_HINT;
    document.body.appendChild(linkTip);
  }
  linkTip.style.left = event.clientX + 'px';
  linkTip.style.top = (event.clientY - 8) + 'px';
  linkTip.classList.add('show');
}
function hideLinkTip() {
  if (linkTip) linkTip.classList.remove('show');
}

function makeXterm() {
  const term = new Terminal({
    cursorBlink: appearance.cursorBlink,
    cursorStyle: appearance.cursorStyle,
    fontFamily: appearance.fontFamily,
    fontSize: appearance.fontSize,
    lineHeight: 1.15,
    scrollback: 10000,
    theme: APPEARANCE.getTheme(appearance.theme).xterm,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Make http(s) links in the pty output open in the default browser — but only
  // on modifier-click (⌘ / Ctrl), with a hover tooltip explaining the shortcut.
  // Main validates the scheme before handing it to the OS. Guarded so a missing
  // addon (e.g. stale vendor bundle) never breaks terminal creation.
  const WebLinks = window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon;
  if (WebLinks) {
    try {
      const activate = (event, uri) => {
        hideLinkTip();
        if (event && event[LINK_MOD]) window.swarm.openExternal(uri);
      };
      term.loadAddon(new WebLinks(activate, {
        hover: (event) => showLinkTip(event),
        leave: () => hideLinkTip(),
      }));
    } catch (_) {}
  }
  return { term, fit };
}

// Launch config for NEW tabs. Two top-level modes (launchMode):
//   'agent' — auto-run an agent CLI. launchList holds the saved agents (each a
//             { cmd, flags }; the UI edits them as one "cmd flags" line). One agent
//             → run it silently; several → a picker on tab open (see pickAgent /
//             resolveLaunch), how often controlled by launchPick ('always'/'folder').
//             The picker always offers a "clean terminal" as the last option too.
//   'blank' — always open a clean shell with NO command; you type it yourself.
// `launch` mirrors launchList[0] for the call sites that want a single fallback.
// When resume-on-relaunch is on and the cmd is Claude-family, we pin each tab with
// `-n swarm-…` and restore via `--resume swarm-…` (see RESUME_API). Clean terminals
// (blank) are never pinned.
let launchList = loadLaunchList();
let launch = launchList[0];
let launchMode = localStorage.getItem('swarm.launchMode') || 'agent';
let launchPick = localStorage.getItem('swarm.launchPick') || 'folder';
// Восстановление разговоров и хуки Клода — БЕЗ настройки, всегда включены. Обе были галками, и
// обе по умолчанию выключенными, то есть из коробки человек жил на худшем варианте, не зная об
// этом. Выключать их незачем:
//   • хуки прописываются только в наш собственный файл настроек, который вкладка получает
//     флагом --settings; глобальный ~/.claude/settings.json не трогается никогда. Без них
//     разрешение и вопрос отличаются угадыванием по экрану;
//   • вкладка, вернувшаяся после перезапуска приложения без своего разговора, — это потерянная
//     работа, а не чистый лист: разговор всё равно лежит на диске.
// Старые ключи в localStorage не читаем сознательно: у того, кто их когда-то выключил, они
// остались бы выключенными навсегда, а спросить об этом уже негде.
const resumeSessions = true;
const hooksEnabled = true;
// Строка статуса Swarm — тоже без настройки, всегда включена, и это стало возможно только
// вместе со склейкой (swarm-statusline.js, readForeign). Галка существовала ради ложной
// развилки: слот statusLine у Клода один, значит наша строка перебивала свою строку человека,
// и он выбирал между ней и работающим приложением — полоской контекста, цифрами /usage и
// перезапуском по контексту, которые кормятся только отсюда. Теперь наш скрипт сам зовёт его
// команду и печатает оба куска, так что терять нечего и выбирать не из чего.
// Режим разрешений, с которым стартуют новые вкладки (Settings → Запуск). Пусто = не
// вмешиваться, и это умолчание: режимы стоят по-разному, и выбирать за человека нельзя.
// Смысл настройки в том, что «разреши уже всё» — самое частое, что делают руками сразу после
// открытия вкладки, а с телефона Shift+Tab не нажать вообще.
let permMode = localStorage.getItem('swarm.permMode') || '';
// «Перезапускать агента, когда контекст заполнится» (Settings → Запуск). Выключено по
// умолчанию: функция сама решает, когда стереть разговор, и включать такое за человека нельзя.
// Порог — в процентах с полоски контекста, то есть отмеренных от точки автосжатия. Логика вся
// в restart.js, здесь только память о выборе.
let restartOn = localStorage.getItem('swarm.restart') === '1';
let restartPct = RESTART_API.clampPct(localStorage.getItem('swarm.restartPct'));
// Split a "cmd --flags" line into { cmd, flags }: first token = launcher, rest = flags.
function parseAgentLine(line) {
  const t = (line || '').trim();
  const sp = t.indexOf(' ');
  return {
    cmd: (sp === -1 ? t : t.slice(0, sp)).trim(),
    flags: (sp === -1 ? '' : t.slice(sp + 1)).trim(),
  };
}

function loadLaunch() {
  let cmd = localStorage.getItem('swarm.launchCmd');
  let flags = localStorage.getItem('swarm.launchFlags');
  // Migrate the old single-string 'swarm.startCommand' (command + flags in one)
  // into the split cmd/flags model, once. First token = launcher, rest = flags.
  if (cmd == null && flags == null) {
    const legacy = (localStorage.getItem('swarm.startCommand') || 'claude').trim();
    const sp = legacy.indexOf(' ');
    cmd = sp === -1 ? legacy : legacy.slice(0, sp);
    flags = sp === -1 ? '' : legacy.slice(sp + 1).trim();
  }
  return { cmd: (cmd || '').trim() || 'claude', flags: (flags || '').trim() };
}

// Read the saved agent list. Absent → migrate from the single legacy launch, so
// existing users keep their one command untouched. Always non-empty.
function loadLaunchList() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem('swarm.launchList') || 'null'); } catch (_) {}
  const list = Array.isArray(raw)
    ? raw
      .map((a) => ({ cmd: (a && a.cmd || '').trim(), flags: (a && a.flags || '').trim() }))
      .filter((a) => a.cmd)
    : [loadLaunch()];
  return list.length ? list : [{ cmd: 'claude', flags: '' }];
}

function saveLaunch() {
  localStorage.setItem('swarm.launchCmd', launch.cmd);
  localStorage.setItem('swarm.launchFlags', launch.flags);
}

function saveLaunchList() {
  localStorage.setItem('swarm.launchList', JSON.stringify(launchList));
  // Keep the single-agent fallback + legacy keys in sync with the first entry.
  launch = launchList[0];
  saveLaunch();
}

function saveLaunchPick() {
  localStorage.setItem('swarm.launchPick', launchPick);
}

function saveLaunchMode() {
  localStorage.setItem('swarm.launchMode', launchMode);
}

// Ярлык команды и решение «разворачивать ли меню на +» живут в launch-word.js: свой модуль,
// свой тест — см. LAUNCH_API ниже.
function agentLabel(a) {
  return window.SWARM_LAUNCH.agentLabel(a);
}

// Ask which saved agent a new tab should launch. Resolves the chosen { cmd, flags },
// { blank: true } for a clean terminal (always the last option), or null on cancel
// (Esc / click-away / "Отмена") — the caller then skips the tab.
function pickAgent() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal pick-agent">
        <div class="modal-msg">Какого агента запустить?</div>
        <div class="pick-list"></div>
        <div class="modal-actions"><button class="modal-cancel">Отмена</button></div>
      </div>`;
    const list = overlay.querySelector('.pick-list');
    launchList.forEach((a, i) => {
      const b = document.createElement('button');
      b.className = 'pick-item';
      b.textContent = agentLabel(a);
      b.addEventListener('click', () => close(launchList[i]));
      list.appendChild(b);
    });
    // A clean shell (no command) is always available as the last option.
    const blankBtn = document.createElement('button');
    blankBtn.className = 'pick-item pick-blank';
    blankBtn.textContent = window.SWARM_LAUNCH.BLANK_LABEL;
    blankBtn.addEventListener('click', () => close({ blank: true }));
    list.appendChild(blankBtn);
    document.body.appendChild(overlay);

    const close = (val) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(val || null);
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); close(null); }
    };
    overlay.querySelector('.modal-cancel').addEventListener('click', () => close(null));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey, true);
    list.querySelector('.pick-item')?.focus();
  });
}

// Decide what a NEW tab launches: { cmd, flags }, { blank: true } for a clean
// terminal, or null to abort (picker cancelled). Never prompts on restore
// (opts carries the saved choice) or with a single saved agent in 'agent' mode.
//   launchMode 'blank' — always a clean terminal;
//   launchMode 'agent' with several agents — the launchPick mode decides:
//     'always' — ask every time;
//     'folder' — reuse the choice of the first tab already open in this folder,
//                only asking when the folder has none yet (its first tab).
async function resolveLaunch(opts, cwd) {
  if (opts.blank) return { blank: true };
  if (opts.cmd != null) {
    return { cmd: opts.cmd, flags: opts.flags != null ? opts.flags : launch.flags };
  }
  if (launchMode === 'blank') return { blank: true };
  if (launchList.length <= 1) return { cmd: launch.cmd, flags: launch.flags };
  if (launchPick === 'folder') {
    const inherited = folderChoice(cwd);
    if (inherited) return inherited;
  }
  return pickAgent();
}

// Чем открылась первая живая вкладка этой папки: { cmd, flags } | { blank: true } | null.
// Ровно то, что унаследует новая вкладка в режиме «как в первой вкладке папки» — поэтому
// и меню на «+», и сам resolveLaunch спрашивают об этом одну функцию: разойдись они, меню
// обещало бы одно, а вкладка открывалась бы другим.
function folderChoice(cwd) {
  const ids = withinOrder.get(cwd) || [];
  for (const sid of ids) {
    const s = sessions.get(sid);
    if (!s) continue;
    if (s.blank) return { blank: true };
    if (s.cmd) return { cmd: s.cmd, flags: s.flags != null ? s.flags : '' };
  }
  return null;
}

// «+» на папке разворачивает выбор: открыть как открывались соседи — или другой командой
// из настроек. Ради одного случая, который иначе тупиковый: упёрся в лимит рабочей подписки
// и хочешь в ЭТОЙ ЖЕ папке вкладку под личной. Раньше выхода было два, и оба плохие — лезть
// в настройки и переключать спрашивание глобально, или набрать `claude-my` руками. Набранное
// руками сворм не достраивает: такая вкладка остаётся без строки статуса с лимитами, без
// хуков, без закреплённого id разговора — то есть без половины того, зачем он нужен.
//
// Меню появляется РОВНО там, где выбор иначе унаследовался бы молча: команд в настройках
// больше одной, папка уже кем-то занята, и режим — «как в первой вкладке папки». В режиме
// «спрашивать каждый раз» спросит сам resolveLaunch, и второе меню поверх первого было бы
// издевательством; при одной команде выбирать не из чего.
function launchMenuEntries(cwd) {
  return window.SWARM_LAUNCH.launchMenuEntries({
    mode: launchMode,
    pick: launchPick,
    list: launchList,
    inherited: folderChoice(cwd),
  });
}

// Закрыть открытое сейчас меню (оно одно на окно) и кнопка, под которой оно висит.
let launchMenuClose = null;
let launchMenuAnchor = null;

// Показать это меню под кнопкой. Отвечает опциями для createSession ({} — «как в папке»,
// то есть сегодняшнее наследование) или null, если меню закрыли не выбрав: тогда вкладки
// не будет вовсе — как при отмене в pickAgent.
function openLaunchMenu(anchor, cwd, toggle) {
  // Прежнее меню закрываем ЧЕСТНО, через его же close, и ДО ВСЕГО — включая случай «меню не
  // понадобится»: иначе оно осталось бы висеть над только что открытой вкладкой, его обещание не
  // разрешилось бы никогда (ждущий повис навсегда), а слушатели мыши и клавиш остались бы на
  // document и гасили чужое меню. Мимо кнопки-хозяйки клик снаружи не закрывает, а ⌘O до мыши не
  // доходит вовсе — сами эти пути и приводят сюда с уже открытым меню.
  //
  // Повторный клик по ТОЙ ЖЕ кнопке — это «закрыть», как у меню команд. Но только там, где меню
  // разворачивается сразу («+» на папке). У кнопки в панели между кликом и меню стоит выбор папки
  // в проводнике, и «закрыть» съело бы уже сделанный человеком выбор: вкладки не было бы вовсе.
  if (launchMenuClose) {
    const again = toggle && launchMenuAnchor === anchor;
    launchMenuClose(null);
    if (again) return Promise.resolve(null);
  }
  const entries = launchMenuEntries(cwd);
  if (!entries) return Promise.resolve({});
  return new Promise((resolve) => {
    launchMenu.innerHTML = '';
    for (const e of entries) {
      const b = document.createElement('button');
      b.className = 'cmd-item';
      b.innerHTML = '<span class="cmd-name"></span>';
      b.querySelector('.cmd-name').textContent = e.label;
      b.addEventListener('click', () => close(e.val));
      launchMenu.appendChild(b);
    }
    const close = (val) => {
      launchMenu.classList.add('hidden');
      launchMenuClose = null;
      launchMenuAnchor = null;
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', onKey, true);
      // Фокус мы забрали у терминала (нижняя строка), а вкладку не открыли — значит вернуть его
      // некому: он остался бы на спрятанной кнопке, то есть нигде, и всё набранное после Esc
      // уходило бы в никуда до клика мышью. На выбранном пункте возвращать не надо — там фокус
      // заберёт новая вкладка.
      if (!val) sessions.get(activeId)?.term.focus();
      resolve(val || null);
    };
    launchMenuClose = close;
    launchMenuAnchor = anchor;
    const outside = (ev) => {
      if (!launchMenu.contains(ev.target) && !anchor.contains(ev.target)) close(null);
    };
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(null); } };
    launchMenu.classList.remove('hidden');
    placeMenuUnder(launchMenu, anchor);
    setTimeout(() => document.addEventListener('mousedown', outside), 0);
    document.addEventListener('keydown', onKey, true);
    launchMenu.querySelector('.cmd-item')?.focus();
  });
}

// Открыть вкладку в этой папке, спросив под кнопкой, чем именно. `toggle` — для кнопок, у которых
// меню разворачивается прямо по клику: повторный клик тогда закрывает (см. openLaunchMenu).
async function createSessionFrom(anchor, cwd, toggle) {
  let pick = await openLaunchMenu(anchor, cwd || '', toggle);
  if (!pick) return;
  // «С выбором режима» — то же окно выбора, каким встречаем первую вкладку новой папки. Под
  // кнопкой список команд не разворачиваем никогда: при десяти вбитых подписках это была бы
  // простыня на месте выбора из двух.
  if (pick.pick) {
    pick = await pickAgent();
    if (!pick) return;                 // передумал в окне выбора — вкладки не будет
  }
  createSession({ cwd: cwd || undefined, ...pick });
}

// Build the line typed into a new/restored tab: optional Claude -n / --resume.
function sessionLaunchCommand({ cmd, flags, sessionKey, sessionId, resume } = {}) {
  return RESUME_API.buildCommand({
    cmd: cmd || launch.cmd,
    flags: flags != null ? flags : launch.flags,
    sessionKey: sessionKey || null,
    sessionId: sessionId || null,
    mode: resume ? 'resume' : 'start',
  });
}

// Learn the launcher from what you type at a shell prompt and bind THIS tab to
// that cmd, so a restore relaunches the same alias/account. The global agent list
// is now curated in Settings, so we no longer silently adopt a typed cmd as the
// default for new tabs — that would mutate a user-managed list behind their back.
//
// Разбор строки живёт в launch-word.js (свой модуль, свой тест — цена ошибки здесь
// видна только после перезапуска, когда вкладка вернулась не тем аккаунтом).
const LAUNCH_API = window.SWARM_LAUNCH;

function launchWordFrom(line) {
  return LAUNCH_API.launchWordFrom(line, launchList);
}

// Главный путь: main говорит, ЧТО крутится в шелле вкладки прямо сейчас (session:proc), а
// мы решаем, агент ли это. Надёжнее любых догадок по набранному: ловит и запуск из
// скрипта, и смену агента внутри вкладки — то есть случай «открыли Клодом, потом запустили
// Cursor командой agent», после которого вкладка возвращалась Клодом.
//
// Чего этот путь НЕ видит — обёртку: шелл разворачивает алиас до exec, и от `claude-my`
// в процессах остаётся `claude`. Такое «уточнение» вкладке во вред (см. isAliasExpansion),
// поэтому оно единственное, которое мы отклоняем.
window.swarm.onTabProcess(({ id, cmd }) => {
  const word = launchWordFrom(cmd);
  if (!word) return;                    // ls, vim, npm — вкладка не про них
  const s = sessions.get(id);
  if (!s || s.blank || s.cmd === word) return;
  if (LAUNCH_API.isAliasExpansion(s.cmd, word)) return;
  relearnCmd(s, word);
  // Запущено не нами — значит и строка запуска у main устарела (см. session:forgetLaunch).
  window.swarm.forgetLaunch(id);
  persistTabs();
});

// Вкладка сменила агента. Флаги СТИРАЕМ вместе с именем: они были от прежнего запуска, а какие
// набрал человек — мы не знаем. Иначе папка, открытая как `claude --model opus`, после ручного
// перехода на codex предлагала бы в меню «codex --model opus» и запускала бы codex с чужим
// флагом; до меню это же враньё уезжало в восстановление вкладки после релонча.
function relearnCmd(s, cmd) {
  s.cmd = cmd;
  s.flags = '';
}

function rememberStartCommand(line, sessionId) {
  const cmd = launchWordFrom(line);
  if (!cmd) return;
  const s = sessions.get(sessionId);
  // Набрано ВНУТРИ агента — не команда шеллу. Клод и прочие TUI живут в альт-экране, и
  // строка «agent» там это реплика в разговоре, а не запуск: раньше такая реплика молча
  // переписывала вкладке команду запуска, и всплывало это только после перезапуска.
  try { if (s && s.term.buffer.active.type === 'alternate') return; } catch (_) { /* нет буфера — считаем шеллом */ }
  // Don't bind a clean terminal to a cmd: it restores empty regardless, so the
  // learned cmd would be dead data.
  if (s && !s.blank && s.cmd !== cmd) {
    relearnCmd(s, cmd);
    window.swarm.forgetLaunch(sessionId);   // см. session:forgetLaunch
    persistTabs();
  }
}

async function createSession(opts = {}) {
  // A plain new session inherits the folder of the one you're currently on;
  // opts.cwd (folder picker) overrides. Main falls back to the default folder.
  const cwd = opts.cwd || sessions.get(activeId)?.cwd;
  // Which agent to launch. May pop a picker when several are saved; cancel aborts
  // the whole tab, so resolve it before we build any xterm/DOM to clean up.
  const chosen = await resolveLaunch(opts, cwd || '');
  if (!chosen) return;
  // A clean terminal runs no command (empty string → main.js types nothing) and is
  // never pinned/resumed. Otherwise it's a normal agent launch.
  const blank = !!chosen.blank;
  const cmd = blank ? '' : chosen.cmd;
  const flags = blank ? '' : chosen.flags;

  const { term, fit } = makeXterm();

  const holder = document.createElement('div');
  holder.className = 'term-holder';
  stageEl.appendChild(holder);
  term.open(holder);
  // xterm reserves space for a scrollbar via `viewport.offsetWidth - scrollArea || 15`.
  // On macOS the scrollbar is overlay (0 layout width), so that measures 0 and the
  // `|| 15` fallback reserves a phantom 15px strip on the right that's just empty —
  // FitAddon subtracts it from the width, so the grid never fills the last ~2 cols.
  // We use an overlay scrollbar (styled thin in CSS, floats over content), so reserve
  // nothing and let the terminal fill the width.
  if (term._core && term._core.viewport) term._core.viewport.scrollBarWidth = 0;
  // Колесо НЕ перехватываем: оно уходит агенту, и листает он свой собственный вид.
  // Claude включает отслеживание мыши (1000/1002/1003/1006) и живёт в альт-экране, где у
  // эмулятора скроллбека нет вовсе — то есть своей прокрутки у вкладки и быть не может,
  // вся прокрутка внутри Клода. Чтобы это чтение не двигало статус, отлистанному экрану
  // не верит ДЕТЕКТОР: он узнаёт отлистанный вид по плашке возврата и держит последний
  // живой снимок (см. screen.scrolledBack).
  fit.fit();

  // Give Claude tabs a stable swarm-* display name (shown in the prompt box and the
  // /resume picker). Other agents: no pin yet.
  let sessionKey = opts.sessionKey || null;
  const claudeCmd = !blank && RESUME_API.supports(cmd);
  const canPin = claudeCmd && resumeSessions;
  if (canPin && !sessionKey) sessionKey = RESUME_API.newSessionKey();
  // Restoring: reopen the exact conversation by its Claude session id — main pins one
  // for every Claude tab, so this works for tabs that were already open when you ticked
  // the setting. The swarm-* name is the fallback for tabs saved before ids were kept.
  // A conversation that's gone from disk is not resumed at all: `--resume` on a dead
  // handle lands in Claude's picker instead of a working agent.
  let resumeId = null;
  if (opts.resume && claudeCmd && opts.claudeSessionId) {
    const ok = await window.swarm.canResumeSession(cwd || '', opts.claudeSessionId);
    if (ok) resumeId = opts.claudeSessionId;
  }
  // Возобновляем ТОЛЬКО по проверенной зацепке. Раньше здесь стояло `resumeId || sessionKey`,
  // и имя вкладки годилось само по себе — а оно есть всегда, даже у вкладки, открытой минуту
  // назад и не сказавшей Клоду ни слова. Такая вкладка после перезапуска уходила в
  // `--resume swarm-…` на несуществующем разговоре и упиралась в «сессия с таким номером не
  // найдена», откуда не выйти ни Enter, ни Esc. Имя тоже проверяется — Клод пишет его в
  // стенограмму, — так что вкладки, сохранённые до появления id, по-прежнему возвращаются.
  let resumeName = null;
  if (opts.resume && claudeCmd && !resumeId && sessionKey && opts.sessionKey) {
    const ok = await window.swarm.canResumeName(cwd || '', sessionKey);
    if (ok) resumeName = sessionKey;
  }
  const doResume = !!(opts.resume && claudeCmd && (resumeId || resumeName));
  // Blank tab → empty command (never fall back to the default agent).
  const command = blank
    ? ''
    : opts.command != null
      ? opts.command
      : sessionLaunchCommand({
        cmd,
        flags,
        sessionKey: canPin ? sessionKey : null,
        sessionId: doResume ? resumeId : null,
        resume: doResume,
      });
  // A key that outlives the process, unlike the per-run session id: the Telegram
  // bridge hangs a forum topic on it, so the same tab lands in the same topic after a
  // relaunch instead of spawning a new one. Restored tabs bring theirs back.
  const tabKey = opts.tabKey || (crypto.randomUUID ? crypto.randomUUID() : 'tab-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  const { id, cwd: resolvedCwd, claudeSessionId } = await window.swarm.createSession({
    cols: term.cols,
    rows: term.rows,
    cwd,
    command,
    tabKey,
    name: opts.name || null,      // main only needs it to title the topic
    // Пока без человека работают ВСЕ вкладки, новая рождается отданной — иначе она одна
    // сняла бы ночной режим в три часа. Main решает то же самое и у себя (awayAll при
    // создании): здесь это не второй источник правды, а зеркало, без которого карточка
    // секунду выглядела бы своей.
    auto: !!opts.auto || (!opts.restored && !!nightNow.on),            // восстановленная вкладка возвращается со своим мандатом
    resumeId: doResume ? resumeId : null,   // restoring: the id this tab reopens
  });

  // Wire keystrokes -> pty. Strip focus in/out reports (CSI I / CSI O): with
  // focus-reporting on, every focus change (clicking the terminal or a tab) makes
  // Claude repaint, and that burst was being read as "работает" for a moment. A
  // multi-tab pulpit doesn't need Claude to track terminal focus.
  // Track what you type at the shell so we can remember a `claude…` launcher and
  // reuse it for new tabs. Buffer printable chars until Enter; backspace pops;
  // an escape sequence (arrow keys / history) resets the line — see the caveat on
  // rememberStartCommand. inEsc persists across chunks (a seq can split).
  let cmdBuf = '';
  let inEsc = false;
  // Разбор набранного — ОТДЕЛЬНО от отправки, и вызывается он только для того, что реально
  // доехало до pty. Иначе выходила ложь: гейт задержал клавиши (или человек нажал «отмена», и
  // они пропали), а приложение уже считало, что в вкладке ответили руками — буферизация
  // уведомления снималась, а в память о лончерах ложилась команда, которой никто не отправлял.
  const scanTyped = (clean) => {
    for (const ch of clean) {
      if (inEsc) { if (/[a-zA-Z~]/.test(ch)) inEsc = false; continue; }
      if (ch === '\x1b') { inEsc = true; cmdBuf = ''; }
      else if (ch === '\r' || ch === '\n') {
        rememberStartCommand(cmdBuf, id);
        cmdBuf = '';
        // Ты ответил САМ: с этого момента уход вкладки из «ждёт» не буферизуем (answeredHere).
        const sess = sessions.get(id);
        if (sess) sess.answeredAt = Date.now();
      }
      else if (ch === '\x7f' || ch === '\b') cmdBuf = cmdBuf.slice(0, -1);
      else if (ch >= ' ') cmdBuf += ch;
    }
  };
  term.onData((data) => {
    const clean = data.replace(/\x1b\[[IO]/g, '');
    if (!clean) return;
    // Не всё, что приходит отсюда, сделал человек: доклады мыши (Клод включает отслеживание,
    // и каждое движение указателя над вкладкой — сообщение) и ответы терминала на запросы
    // приложения — это речь ТЕРМИНАЛА, а не печать (см. termtalk.js). Она уезжает в pty
    // напрямую, мимо границы владения и мимо разбора набранного: иначе отданную вкладку
    // нельзя даже открыть — мышь поднимает модалку на каждое шевеление, — а придержанного
    // ответа приложение ждёт вечно.
    if (TERMTALK.isTerminalTalk(clean)) { window.swarm.sendInput(id, clean); return; }
    typeInto(id, clean);
  });

  // Remap configured chords → canonical bytes Claude/readline understand.
  // Also intercept app actions (scroll-to-bottom) so xterm doesn't eat the key first.
  // return false stops xterm from also emitting its own sequence for that key.
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    const bytes = KEYBINDS_API.matchInputBytes(keybinds, ev);
    if (!bytes) return true;
    ev.preventDefault();
    typeInto(id, bytes);
    return false;
  });

  // Wire terminal resize -> pty resize.
  term.onResize(({ cols, rows }) => window.swarm.resize(id, cols, rows));

  // Build the tab / card.
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.innerHTML = `
    <span class="grip" title="Перетащить">${ICONS.grip}</span>
    <span class="dot"></span>
    <span class="body">
      <span class="label"></span>
      <span class="ctx" hidden>
        <span class="ctx-track"><span class="ctx-fill"></span></span>
        <span class="ctx-num"></span>
      </span>
      <span class="foot">
        <span class="sub">готов</span>
        <span class="hold" hidden></span>
        <span class="agents" hidden title="работающие сабагенты">${ICONS.agents}<span class="agents-num"></span></span>
      </span>
    </span>
    ${tabTools()}
  `;
  // Name: restored name if given, else folder basename (de-duplicated).
  const folderName = resolvedCwd ? basename(resolvedCwd) : 'claude';
  tab.querySelector('.label').textContent = opts.name || defaultName(folderName);
  window.swarm.setTabName(id, tab.querySelector('.label').textContent);
  tab.addEventListener('click', (e) => {
    // closest, а не сам target: внутри кнопок лежат svg, и клик приходит в них.
    if (e.target.closest('.close')) { requestCloseSession(id); return; }
    // Полумесяц — единственная кнопка на карточке, кроме крестика: клик по ней НЕ открывает
    // вкладку. Иначе жест «отдать вкладку» тянул бы за собой уход из той, в которой сидишь.
    if (e.target.closest('.moon')) { e.stopPropagation(); toggleTabAuto(id); return; }
    activate(id);
  });
  // Меню карточки — родное меню системы (его собирает main). Правый клик по карточке жест
  // ожидаемый, а рисовать под один пункт свой попап значило бы вторую машинерию меню.
  tab.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.swarm.night.tabMenu(id);
  });
  tab.dataset.sid = id;
  attachDragHandle(tab, tab.querySelector('.grip'), () => {
    const cwd = sessions.get(id)?.cwd || '';
    // A card in a multi-tab group reorders within the folder; a loner is itself a
    // top-level unit (reorders among folders/loners, never into a folder).
    const inGroup = (withinOrder.get(cwd) || []).length > 1;

    return inGroup ? { kind: 'card', id, cwd } : { kind: 'unit', cwd };
  });
  attachRename(tab.querySelector('.label'));

  sessions.set(id, {
    term, fit, holder, tab, alive: true, status: null, cwd: resolvedCwd, id, sumDot: null,
    cmd, flags, blank, sessionKey: sessionKey || null, tabKey, sub: 0, rawStatus: null, rawDetail: null,
    answeredAt: 0,   // когда ты последний раз нажал Enter в этой вкладке (см. answeredHere)
    // Разбор набранного (см. scanTyped): зовётся ровно там, где ввод доехал до pty, — из
    // typeInto и из гейта, когда тот досылает задержанное.
    scanTyped,
    // Мандат «работает без меня». Живёт вместе с вкладкой (persistTabs) и дублирует то, что
    // знает main: окну он нужен для отметки на карточке и для границы владения (см. typeInto).
    auto: !!opts.auto,
    // The conversation this tab is in. Saved with the tab; the next launch resumes it.
    claudeSessionId: claudeSessionId || null,
  });
  const okey = resolvedCwd || '';
  if (!folderOrder.includes(okey)) folderOrder.push(okey);
  if (!withinOrder.has(okey)) withinOrder.set(okey, []);
  if (!withinOrder.get(okey).includes(id)) withinOrder.get(okey).push(id);
  if (opts.auto || (!opts.restored && nightNow.on)) applyTabAuto(id, true);
  relayoutTabs();
  persistTabs();
  setStatus(id, 'ready', 'готов');
  activate(id);
}

// Last path segment of a folder path, used as the tab label.
function basename(p) {
  const parts = p.split(/[\\/]/).filter(Boolean);

  return parts.length ? parts[parts.length - 1] : p;
}

// Pick a folder, then open a session whose cwd is that folder (label = its name).
// The dialog opens at the current session's folder (or the last one picked).
async function createSessionInFolder() {
  const base = sessions.get(activeId)?.cwd || lastFolder || undefined;
  const dir = await window.swarm.pickFolder(base);
  if (!dir) return;
  lastFolder = dir;
  // Та же развилка, что и у «+» на папке, — но только если папка уже занята: выбранная в
  // проводнике пустая папка спросит сама (первая вкладка папки), и меню было бы вторым
  // вопросом подряд об одном и том же.
  createSessionFrom(newTabBtn, dir);
}

// --- git status bar ----------------------------------------------------------
// The bar reflects the ACTIVE tab's folder. Every refresh re-checks activeId
// after its await so a fast tab switch mid-request can't paint stale data.
function renderGitBar(info) {
  gitInfo = info;
  if (!info || !info.isRepo) { gitBtn.hidden = true; gitDiffBtn.hidden = true; return; }
  gitBtn.hidden = false;
  gitBtn.querySelector('.git-ic').innerHTML = ICONS.branch;
  gitBtn.querySelector('.git-name').textContent = info.branch || '';
  const parts = [];
  if (info.behind) parts.push('↓' + info.behind);
  if (info.ahead) parts.push('↑' + info.ahead);
  // No '*' for dirty: the +N −M counter next door says the same thing, better.
  // info.dirty stays in git.js' contract — it's a standalone module — we just
  // stopped drawing it.
  gitBtn.querySelector('.git-track').textContent = parts.join(' ');
}

// The counter next to the branch. Hidden when there's nothing to show, exactly
// like the branch button on a non-repo folder.
function renderGitDiff(stat) {
  gitDiff = stat;
  if (!stat || (!stat.added && !stat.removed)) { gitDiffBtn.hidden = true; return; }
  const { added, removed } = window.SWARM_DIFF.formatCount(stat);
  gitDiffBtn.hidden = false;
  gitDiffBtn.querySelector('.d-add').textContent = added;
  gitDiffBtn.querySelector('.d-del').textContent = removed;

  // The overlay is a snapshot. When the counter drifts from what it's showing,
  // say so — but never re-render under the reader's cursor.
  if (diffOverlay) {
    const shown = diffOverlay.dataset.sum || '';
    const now = stat ? stat.added + '/' + stat.removed : '0/0';
    diffOverlay.querySelector('.diff-stale').hidden = (shown === now);
  }
}

async function refreshGit() {
  const forId = activeId;
  const cwd = sessions.get(activeId)?.cwd || '';
  let info = null;
  try { info = await window.swarm.git.info(cwd); } catch (_) {}
  if (forId !== activeId) return; // switched tabs during the await — drop stale
  renderGitBar(info);
  if (!info || !info.isRepo) { renderGitDiff(null); return; }

  // A big repo's --numstat may outlive the 2.5s tick; without this guard the
  // ticks would pile up on each other.
  if (gitDiffBusy) return;
  gitDiffBusy = true;
  let stat = null;
  try { stat = await window.swarm.git.diffstat(cwd); } catch (_) {}
  finally { gitDiffBusy = false; }
  if (forId !== activeId) return; // switched again during the diff — drop stale
  renderGitDiff(stat);
}

// A short-lived message in the bar (e.g. checkout failed / needs login).
// timeout 0 keeps it until the next call (used for "обновляю…").
function showGitMsg(text, timeout = 4000) {
  if (gitMsgTimer) { clearTimeout(gitMsgTimer); gitMsgTimer = null; }
  gitMsgEl.textContent = text || '';
  if (text && timeout) gitMsgTimer = setTimeout(() => { gitMsgEl.textContent = ''; }, timeout);
}
function clearGitMsg() { showGitMsg(''); }

// True when a fetch/pull failed because git needs credentials we can't prompt
// for (our background git runs with GIT_TERMINAL_PROMPT=0, so it fails fast
// instead of hanging). Non-technical users get a friendly modal explaining how
// to log in — not the raw git error.
function isGitAuthError(err) {
  return /could not read Username|could not read Password|Authentication failed|Invalid username or password|terminal prompts disabled|no credential|Permission denied|Host key verification|Could not read from remote repository|fatal: Authentication/i.test(err || '');
}

// Plain-language dialog shown when a remote sync (fetch/pull) needs a git login.
// Local branch work (view/switch) never triggers this — only server sync does.
function showGitLoginModal() {
  if (document.querySelector('.modal-overlay .modal.git-login')) return; // already open
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal git-login">
      <div class="modal-title">Нужен вход в Git</div>
      <div class="modal-msg">
        Чтобы <b>обновить</b> или <b>подтянуть</b> изменения с сервера, на этом
        компьютере нужно войти в Git. Просмотр и переключение веток работают и
        без входа — это делается локально.<br><br>
        <b>Как войти (один раз):</b> открой любую вкладку с агентом и набери в
        терминале <code>git fetch</code>. Git спросит логин и пароль (или токен) —
        введи их, дальше он запомнит. Если не знаешь данные — попроси того, кто
        настраивал проект.
      </div>
      <div class="modal-actions"><button class="modal-ok neutral">Понятно</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const btn = overlay.querySelector('.modal-ok');
  const close = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); };
  const onKey = (ev) => { if (ev.key === 'Escape' || ev.key === 'Enter') { ev.preventDefault(); close(); } };
  btn.addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  btn.focus();
}

// --- settings (⚙) ------------------------------------------------------------
// Tabbed modal. "Запуск": the list of agents (cmd + flags) a NEW tab can run and
// the pick mode when there's more than one (global; open tabs untouched — see
// loadLaunchList/resolveLaunch/saveLaunchList). "Уведомления": the system-notification
// prefs (mirrors the 🔔 quick-mute; see maybeNotify).
function showSettingsModal(tab) {
  if (document.querySelector('.modal-overlay .modal.settings')) return; // already open
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal settings">
      <nav class="set-tabs" role="tablist">
        <div class="set-nav-h">Настройки</div>
        <button class="set-tab" data-tab="launch">Запуск</button>
        <button class="set-tab" data-tab="notify">Уведомления</button>
        <button class="set-tab" data-tab="appearance">Вид</button>
        <button class="set-tab" data-tab="tabs">Вкладки</button>
        <button class="set-tab" data-tab="keys">Клавиши</button>
        <button class="set-tab" data-tab="telegram">Телеграм</button>
        <button class="set-tab" data-tab="night">Ночной режим</button>
        <button class="set-tab" data-tab="updates">Обновления</button>
      </nav>

      <div class="set-main">
      <div class="set-body">
      <div class="set-panel" data-panel="launch">
        <header class="set-panel-h">
          <h2 class="set-h">Запуск</h2>
          <p class="set-intro">Что запускать в <b>новых</b> вкладках. Уже открытые сессии не трогаем.</p>
        </header>
        <section class="set-group">
          <div class="set-group-h">Новая вкладка</div>
          <div class="set-row">
            <label class="set-radio">
              <input type="radio" name="set-mode" value="agent" />
              <span class="set-check-tx">Запускать агента автоматически</span>
            </label>
          </div>
          <div class="set-row">
            <label class="set-radio">
              <input type="radio" name="set-mode" value="blank" />
              <span class="set-check-tx">Всегда открывать чистый терминал</span>
            </label>
            <button type="button" class="set-q" aria-label="подсказка">?</button>
            <span class="set-hint" hidden>Вкладка открывается пустой оболочкой, без команды — вводите её сами.</span>
          </div>
        </section>
        <div id="set-agent-block">
          <section class="set-group">
            <div class="set-group-h">
              <span>Команды</span>
              <button type="button" class="set-q" aria-label="подсказка">?</button>
              <span class="set-hint" hidden>Команда вместе с флагами: <code>claude</code>,
                <code>cld --model sonnet</code>, <code>claude-glm --dangerously-skip-permissions</code>…
                При нескольких спросим при открытии вкладки — в списке будет и «Чистый терминал».</span>
            </div>
            <div class="agent-list" id="set-agent-list"></div>
            <button type="button" class="set-check-btn agent-add" id="set-agent-add">+ Добавить команду</button>
            <div class="set-field" id="set-pick-field">
              <div class="set-head"><span class="set-label">Если команд несколько</span></div>
              <div class="set-row">
                <label class="set-radio">
                  <input type="radio" name="set-pick" value="always" />
                  <span class="set-check-tx">Спрашивать каждый раз при открытии вкладки</span>
                </label>
              </div>
              <div class="set-row">
                <label class="set-radio">
                  <input type="radio" name="set-pick" value="folder" />
                  <span class="set-check-tx">Как в первой вкладке папки</span>
                </label>
                <button type="button" class="set-q" aria-label="подсказка">?</button>
                <span class="set-hint" hidden>Спросим только на первой вкладке папки, дальше — тот же выбор.
                  Открыть папку другой командой можно через «+» на ней.</span>
              </div>
            </div>
          </section>
          <section class="set-group">
            <div class="set-group-h">Как ведёт себя агент</div>
            <div class="set-field is-row">
              <div class="set-head">
                <span class="set-label">Вкладки стартуют в режиме</span>
                <button type="button" class="set-q" aria-label="подсказка">?</button>
                <span class="set-hint" hidden>Режим разрешений, с которым открывается вкладка — и новая, и
                  восстановленная после перезапуска. Дальше он переключается как обычно: Shift+Tab за компьютером
                  или кнопкой из телеги. С телефона это единственный способ задать его заранее — Shift+Tab там не
                  нажать. Свой <span class="set-mono">--permission-mode</span> во флагах агента побеждает.</span>
              </div>
              <select class="set-input set-select" id="set-perm-mode"></select>
              <span class="set-note" id="set-perm-mode-note"></span>
            </div>
            <div class="set-row">
              <label class="set-check">
                <input type="checkbox" id="set-restart" />
                <span class="set-check-tx">Перезапускать агента, когда контекст заполнится</span>
              </label>
              <button type="button" class="set-q" aria-label="подсказка">?</button>
              <span class="set-hint" hidden>Агент тупеет задолго до конца окна, а сам себя почистить не может.
                Спросим его, можно ли сейчас: он зафиксирует эстафету — записку себе будущему — и мы стартуем
                свежую сессию в этой же вкладке, с её задачей. Решает он: пока стоит на середине работы, отвечает
                «не сейчас». Нужна наша строка статуса — из неё берётся заполнение контекста. А если перезапуск
                нужен прямо сейчас, его зовут файлом <span class="set-mono">.swarm-restart.json</span> в папке
                вкладки — как он устроен, написано в инструкции.</span>
            </div>
            <div class="set-sub">
              <div class="set-field is-row">
                <div class="set-head">
                  <span class="set-label">Спрашивать при заполнении</span>
                  <button type="button" class="set-q" aria-label="подсказка">?</button>
                  <span class="set-hint" hidden>То же число, что на полоске контекста вкладки. Считается от точки
                    автосжатия: на 100% Клод сжимает разговор сам, так что позже нас уже поздно. Левее — чаще
                    перезапуски, агент свежее. Правее — реже, одна сессия живёт дольше.</span>
                </div>
                <div class="set-range">
                  <input type="range" class="set-range-input" id="set-restart-pct" />
                  <span class="set-range-num" id="set-restart-pct-num"></span>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <div class="set-panel" data-panel="notify">
        <header class="set-panel-h">
          <h2 class="set-h">Уведомления</h2>
          <p class="set-intro">Пинг, когда фоновая вкладка закончила или ждёт ответа.</p>
        </header>
        <section class="set-group">
          <div class="set-row">
            <label class="set-check">
              <input type="checkbox" id="set-notify-on" />
              <span class="set-check-tx"><b>Уведомления включены</b></span>
            </label>
          </div>
          <div class="set-sub" id="set-notify-sub">
            <div class="set-row">
              <label class="set-check">
                <input type="checkbox" id="set-notify-ready" />
                <span class="set-check-tx">Когда агент закончил — <span class="set-lit">готов</span></span>
              </label>
            </div>
            <div class="set-row">
              <label class="set-check">
                <input type="checkbox" id="set-notify-waiting" />
                <span class="set-check-tx">Когда агент ждёт ответа — <span class="set-lit">ждёт ответа</span></span>
              </label>
            </div>
            <div class="set-row">
              <label class="set-check">
                <input type="checkbox" id="set-notify-active" />
                <span class="set-check-tx">Пинговать, даже если я смотрю на эту вкладку</span>
              </label>
              <button type="button" class="set-q" aria-label="подсказка">?</button>
              <span class="set-hint" hidden>Фокус окна не значит, что человек за столом: одна вкладка,
                вы ушли за кофе, окно так и осталось активным — и без этого пинга итог придёт в тишине.
                Выключите, если мешает баннер о том, что и так у вас перед глазами.</span>
            </div>
            <div class="set-row">
              <label class="set-check">
                <input type="checkbox" id="set-notify-sound" />
                <span class="set-check-tx">Звук</span>
              </label>
            </div>
          </div>
        </section>
      </div>

      <div class="set-panel" data-panel="appearance">
        <header class="set-panel-h">
          <h2 class="set-h">Вид</h2>
          <p class="set-intro">Оформление терминала. Применяется ко <b>всем</b> вкладкам сразу.</p>
        </header>
        <section class="set-group">
          <div class="set-group-h">Терминал</div>
          <div class="set-field is-row">
            <div class="set-head"><span class="set-label">Тема</span></div>
            <select class="set-input" id="set-theme"></select>
          </div>
          <div class="set-field is-row">
            <div class="set-head"><span class="set-label">Шрифт</span></div>
            <select class="set-input" id="set-font-family"></select>
          </div>
          <div class="set-field is-row">
            <div class="set-head"><span class="set-label">Размер шрифта</span></div>
            <div class="set-stepper">
              <button type="button" class="step-btn" id="set-font-dec" aria-label="меньше">−</button>
              <span class="step-val" id="set-font-val"></span>
              <button type="button" class="step-btn" id="set-font-inc" aria-label="больше">+</button>
            </div>
          </div>
          <div class="set-field is-row">
            <div class="set-head"><span class="set-label">Курсор</span></div>
            <select class="set-input" id="set-cursor-style"></select>
          </div>
          <div class="set-row">
            <label class="set-check">
              <input type="checkbox" id="set-cursor-blink" />
              <span class="set-check-tx">Мигание курсора</span>
            </label>
          </div>
          <div class="term-preview" id="set-term-preview"></div>
        </section>
        <section class="set-group">
          <div class="set-group-h">Окно</div>
          <div class="set-row">
            <label class="set-check">
              <input type="checkbox" id="set-pult" />
              <span class="set-check-tx">Показывать пульт</span>
            </label>
            <button type="button" class="set-q" aria-label="подсказка">?</button>
            <span class="set-hint" hidden>Вкладка ${key('0')} с очередью агентов, которые ждут ответа.</span>
          </div>
        </section>
      </div>

      <div class="set-panel" data-panel="tabs">
        <header class="set-panel-h">
          <h2 class="set-h">Вкладки</h2>
          <p class="set-intro">Как выглядят карточки сессий. Заголовок показывается всегда.</p>
        </header>
        <section class="set-group">
          <div class="set-group-h">Где и как плотно</div>
          <div class="set-field is-row">
            <div class="set-head">
              <span class="set-label">Раскладка</span>
              <button type="button" class="set-q" aria-label="подсказка">?</button>
              <span class="set-hint" hidden>Где живут вкладки — списком слева или карточками сверху (${key('L')}).</span>
            </div>
            <select class="set-input" id="set-layout"></select>
          </div>
          <div class="set-field is-row">
            <div class="set-head"><span class="set-label">Плотность</span></div>
            <select class="set-input" id="set-tab-density"></select>
          </div>
        </section>
        <section class="set-group">
          <div class="set-group-h">Что показывать на карточке</div>
          <div class="set-field is-row">
            <div class="set-head">
              <span class="set-label">Статус</span>
              <button type="button" class="set-q" aria-label="подсказка">?</button>
              <span class="set-hint" hidden>Точкой — цветной кружок слева, карточка остаётся спокойной.
                Заливкой — цвет статуса заливает фон и рамку всей карточки: видно с другого конца экрана,
                но список из десяти цветных плашек шумит. Подпись словами настраивается отдельно.</span>
            </div>
            <select class="set-input" id="set-tab-status"></select>
          </div>
          <div class="set-row">
            <label class="set-check">
              <input type="checkbox" id="set-tab-ctx" />
              <span class="set-check-tx">Метр контекста</span>
            </label>
            <button type="button" class="set-q" aria-label="подсказка">?</button>
            <span class="set-hint" hidden>Тонкая полоска заполнения контекста Claude по нижнему краю карточки.</span>
          </div>
          <div class="set-row">
            <label class="set-check">
              <input type="checkbox" id="set-tab-sub" />
              <span class="set-check-tx">Подпись статуса</span>
            </label>
            <button type="button" class="set-q" aria-label="подсказка">?</button>
            <span class="set-hint" hidden>Словами под заголовком: готов / работает / завис?</span>
          </div>
        </section>
        <section class="set-group">
          <div class="set-group-h">
            <span>Цвета статусов</span>
            <button type="button" class="set-q" aria-label="подсказка">?</button>
            <span class="set-hint" hidden>Красят не только карточки: точку свёрнутой группы, чипы Пульта, строки статуса. Открытую вкладку обводит цвет её же статуса — отдельного цвета у неё нет.</span>
          </div>
          <div class="color-row" id="set-tab-colors"></div>
          <button type="button" class="set-check-btn" id="set-tab-colors-reset">Сбросить цвета</button>
        </section>
        <section class="set-group">
          <div class="set-group-h">Предпросмотр</div>
          <div class="tab-preview" id="set-tab-preview"></div>
        </section>
      </div>

      <div class="set-panel" data-panel="keys">
        <header class="set-panel-h">
          <h2 class="set-h">Клавиши</h2>
          <p class="set-intro">Модификатор «Слово» / «До края» + ←→ / Backspace / Delete. Перенос строки — отдельный хоткей.</p>
        </header>
        <section class="set-group">
          <div class="set-group-h">
            <span>Сочетания</span>
            <button type="button" class="set-q" aria-label="подсказка">?</button>
            <span class="set-hint" hidden>Стрелки перемещают, Backspace/Delete удаляют — в выбранной единице:
              слово или до края строки.</span>
          </div>
          <div class="kb-list" id="set-kb-list"></div>
        </section>
      </div>

      <div class="set-panel" data-panel="telegram">
        <header class="set-panel-h">
          <h2 class="set-h">Телеграм</h2>
          <p class="set-intro">Свой бот, чтобы отвечать агентам с телефона. Токен хранится
            зашифрованным на этом компьютере и наружу не уходит.</p>
        </header>

        <div class="tg-step">
          <div class="tg-step-head">
            <span class="tg-step-n">1</span>
            <span class="tg-step-name">Заводим бота</span>
            <span class="tg-step-mark" id="set-tg-mark1"></span>
          </div>
          <div class="tg-step-body">
            <span class="set-note">Откройте <a class="tg-link" id="set-tg-bf" href="#">@BotFather</a>,
              отправьте ему <span class="set-mono">/newbot</span> и придумайте имя. В ответ он
              пришлёт строку вида <span class="set-mono">1234567890:AA…</span> — вставьте её сюда.
              Бот — это аккаунт в Телеграме, а не программа на сервере: размещать и платить нечего.</span>
            <div class="tg-row">
              <input class="set-input set-code" type="password" id="set-tg-token" spellcheck="false"
                     autocapitalize="off" autocorrect="off" placeholder="1234567890:AA…" />
              <button type="button" class="set-check-btn" id="set-tg-save">Подключить</button>
            </div>
            <div class="tg-state" id="set-tg-state"></div>
          </div>
        </div>

        <div class="tg-step" id="set-tg-chat-field" hidden>
          <div class="tg-step-head">
            <span class="tg-step-n">2</span>
            <span class="tg-step-name">Привязываем группу</span>
            <span class="tg-step-mark" id="set-tg-mark2"></span>
          </div>
          <div class="tg-step-body">
            <span class="set-note" id="set-tg-step2-why">В Телеграме: создайте группу
              (можно одному), зайдите в её настройки и включите <b>«Темы»</b>. Каждая вкладка
              получит там свою тему — иначе на телефоне агентов не различить.
              <br>Потом нажмите «Привязать группу»: появится QR и код. QR добавляет бота в
              выбранную группу, а код нужно отправить в неё сообщением — по нему приложение и
              поймёт, какая группа ваша. Осталось сделать бота <b>администратором</b> группы.</span>
            <div class="tg-pair" id="set-tg-pair" hidden>
              <img class="tg-qr" id="set-tg-qr" alt="QR: добавить бота в группу" hidden />
              <div class="tg-pair-side">
                <div class="tg-code" id="set-tg-code"></div>
                <a class="tg-link" id="set-tg-link" href="#" target="_blank" rel="noreferrer">добавить бота в группу</a>
                <div class="set-note" id="set-tg-ttl"></div>
              </div>
            </div>
            <ul class="tg-checks" id="set-tg-checks" hidden></ul>
            <div class="tg-state" id="set-tg-check-note"></div>
            <div class="tg-row tg-row-wrap">
              <button type="button" class="set-check-btn" id="set-tg-pair-btn">Привязать группу</button>
              <button type="button" class="set-check-btn" id="set-tg-check" hidden>Проверить ещё раз</button>
            </div>
          </div>
        </div>

        <div class="tg-step" id="set-tg-step3" hidden>
          <div class="tg-step-head">
            <span class="tg-step-n">3</span>
            <span class="tg-step-name">Мост в эфире</span>
            <span class="tg-step-mark" id="set-tg-mark3"></span>
          </div>
          <div class="tg-step-body">
            <div class="tg-state" id="set-tg-live"></div>
            <div class="tg-row tg-row-wrap">
              <button type="button" class="set-check-btn" id="set-tg-reconnect" hidden>Подключить заново</button>
            </div>
            <span class="set-note">Пишете в тему — попадаете в её агента; его вопросы и
              итоги приходят туда же. Закрыли вкладку — её тема исчезает из группы, и наоборот:
              переименовали тему в телеге — вкладка переименуется на компьютере.
              <br>Запрос разрешения приходит <b>кнопками с вариантами самого Клода</b>: нажали —
              приложение напечатало этот номер. Словами разрешение не даётся, одобрить можно
              только то, что видно на кнопке.
              <br>В тему можно прислать <b>скриншот</b> — сворм положит его файлом на этот
              компьютер и отдаст агенту путь, тот посмотрит сам. Подпись к картинке станет
              задачей. Голосовые тоже принимаются, если включить их ниже.
              <br>Команды: <span class="set-mono">/tabs</span> — кто чем занят,
              <span class="set-mono">/new</span> — ещё один агент в папке этой темы,
              <span class="set-mono">/mode edits</span> — разрешить агенту правки без спроса,
              <span class="set-mono">/sync</span> — привести темы в соответствие с вкладками,
              <span class="set-mono">/help</span> — напоминалка.</span>
          </div>
        </div>

        <div id="set-tg-extra" hidden>
          <section class="set-group">
            <div class="set-group-h">
              <span>Насколько подробно отвечать в телегу</span>
              <button type="button" class="set-q" aria-label="подсказка">?</button>
              <span class="set-hint" hidden>Это просьба агенту, а не обрезка его ответа: мост
                подставляет её к первому сообщению из телеги, дальше идёт короткая метка
                <span class="set-lit">[тлг]</span>.</span>
            </div>
            <div class="set-row">
              <label class="set-radio">
                <input type="radio" name="tg-detail" id="set-tg-detail-short" />
                <span class="set-check-tx">Кратко</span>
              </label>
              <button type="button" class="set-q" aria-label="подсказка">?</button>
              <span class="set-hint" hidden>По-телефонному: без длинных блоков кода и путей, суть в паре фраз.</span>
            </div>
            <div class="set-row">
              <label class="set-radio">
                <input type="radio" name="tg-detail" id="set-tg-detail-full" />
                <span class="set-check-tx">Полностью</span>
              </label>
              <button type="button" class="set-q" aria-label="подсказка">?</button>
              <span class="set-hint" hidden>Как за компьютером; длинный ответ придёт несколькими сообщениями.</span>
            </div>
            <div class="set-row">
              <label class="set-radio">
                <input type="radio" name="tg-detail" id="set-tg-detail-custom" />
                <span class="set-check-tx">Своя формулировка</span>
              </label>
              <button type="button" class="set-q" aria-label="подсказка">?</button>
              <span class="set-hint" hidden>Своя просьба вместо обеих заготовок. Пока выбрана она,
                «кратко» и «полностью» не действуют — поэтому она и стоит третьим положением, а не
                кнопкой рядом: выбор один, и видно, который в силе.</span>
            </div>
            <div id="set-tg-prompt-box" hidden>
              <textarea class="set-input set-prose" id="set-tg-prompt" rows="2" spellcheck="false"></textarea>
            </div>
          </section>

          <section class="set-group">
            <div class="set-group-h">
              <span>Голосовые сообщения</span>
              <button type="button" class="set-q" aria-label="подсказка">?</button>
              <span class="set-hint" hidden>Можно надиктовать задачу голосом. Распознаётся
                <b>на этом компьютере</b> — запись никуда не отправляется. Для этого нужна модель
                распознавания: её нет в приложении, поэтому кнопка скачает её один раз. Не нужны
                голосовые — просто не нажимайте, ничего не скачается.</span>
            </div>
            <div class="tg-row tg-row-wrap">
              <label class="set-inline">Качество
                <select class="set-input set-select" id="set-voice-model"></select>
              </label>
              <button type="button" class="set-check-btn" id="set-voice-install">Включить голосовые</button>
              <button type="button" class="set-check-btn" id="set-voice-cancel" hidden>Отменить</button>
              <button type="button" class="set-check-btn danger" id="set-voice-remove" hidden>Удалить</button>
            </div>
            <div class="upd-progress" id="set-voice-progress" hidden><div class="upd-bar" id="set-voice-bar"></div></div>
            <div class="tg-state" id="set-voice-note"></div>
            <div class="tg-row tg-row-wrap">
              <button type="button" class="set-check-btn" id="set-voice-manual">Уже есть whisper.cpp</button>
            </div>
            <div id="set-voice-manual-box" hidden>
              <span class="set-note" id="set-tg-voice-hint"></span>
              <div class="tg-row">
                <input class="set-input set-code" type="text" id="set-tg-wbin" spellcheck="false"
                       placeholder="путь к whisper-cli (пусто — искать в PATH)" />
              </div>
              <div class="tg-row">
                <input class="set-input set-code" type="text" id="set-tg-wmodel" spellcheck="false"
                       placeholder="путь к модели ggml-*.bin" />
              </div>
            </div>
          </section>

          <section class="set-group">
            <div class="set-group-h">
              <span>Когда писать в телегу</span>
              <button type="button" class="set-q" aria-label="подсказка">?</button>
              <span class="set-hint" hidden>Сам мост пишет, пока вы «за телефоном» — это
                иконка в правом нижнем углу или команда боту <span class="set-mono">/phone</span>.
                За компом он молчит: вкладки перед вами. Ответы на ваши сообщения и команды
                приходят всегда, где бы вы ни были.</span>
            </div>
            <div class="set-row">
              <label class="set-check">
                <input type="checkbox" id="set-tg-awake" />
                <span class="set-check-tx">Не давать компьютеру засыпать, пока вас нет</span>
              </label>
              <button type="button" class="set-q" aria-label="подсказка">?</button>
              <span class="set-hint" hidden>Со спящей машиной отвечать некому: агенты живут здесь, а не на
                сервере. Держит бодрым только в положении «за телефоном» — пока вы рядом, сон вам не мешает.</span>
            </div>
          </section>
        </div>

        <section class="set-group" id="set-tg-trouble" hidden>
          <div class="set-group-h">
            <span>Если что-то не так</span>
            <button type="button" class="set-q" aria-label="подсказка">?</button>
            <span class="set-hint" hidden>Мост пишет журнал: кто что прислал, куда ушло и
              почему. Пригодится, чтобы разобраться или отправить разработчику.
              <br>«Отвязать группу» оставляет бота подключённым — можно привязать другую.
              «Удалить токен» стирает бота с этого компьютера целиком.</span>
          </div>
          <div class="tg-row tg-row-wrap">
            <button type="button" class="set-check-btn" id="set-tg-log">Показать журнал моста</button>
            <button type="button" class="set-check-btn" id="set-tg-unpair" hidden>Отвязать группу</button>
            <button type="button" class="set-check-btn danger" id="set-tg-forget">Удалить токен</button>
          </div>
        </section>
      </div>

      <div class="set-panel" data-panel="night">
        <header class="set-panel-h">
          <h2 class="set-h">Ночной режим</h2>
          <p class="set-intro">Ночной режим — это работа, пока вас нет рядом. Агент в нём сам
            решает всё, что легко переделать, а на дорогом решении останавливается и ждёт вашего
            возвращения. Состояние одно — «эта вкладка отдана», — а дверей к нему две: полумесяц
            на карточке (или <span class="set-mono">/night</span> в её теме в телеграме) отдаёт
            одну вкладку, луна в нижней панели — все разом. Когда отданы все, панель синеет;
            забрали одну — синева уходит, остальные продолжают. Закончив задачу, вкладка
            позеленеет и напишет итог — его вы и прочитаете, вернувшись.</p>
          <p class="set-intro">Разрешения в такой вкладке сворм берёт на себя там, где переделать
            дёшево: посмотреть в гит (<span class="set-mono">status</span>,
            <span class="set-mono">diff</span>, <span class="set-mono">log</span>), добавить файлы
            по именам и зафиксировать их. Иначе ночь вставала на промежуточном коммите и до утра
            не двигалась. Всё остальное — <span class="set-mono">push</span>,
            <span class="set-mono">tag</span>, <span class="set-mono">reset</span>,
            <span class="set-mono">add -A</span> и любая не-гитовая команда — по-прежнему ждёт
            вас.</p>
        </header>
        <section class="set-group">
          <div class="set-group-h">
            <span>Что сворм пишет агенту, пока вас нет</span>
            <button type="button" class="set-q" aria-label="подсказка">?</button>
            <span class="set-hint" hidden>Пока вас нет, отвечает агенту сам сворм — вот этими
              двумя текстами. В полях уже лежат его заготовки: правьте их как обычный текст,
              а кнопка под полем вернёт заготовку назад. Пишите только про свой уклад — что агенту
              решать самому, а на чём останавливаться. Служебное сворм допишет сам, и потерять его,
              переписав поле, нельзя.</span>
          </div>
          <div class="set-field">
            <div class="set-head">
              <span class="set-label">Правило</span>
              <button type="button" class="set-q" aria-label="подсказка">?</button>
              <span class="set-hint" hidden>Агент собрался спросить вас и показать варианты —
                и вместо вас отвечает сворм, вот этим текстом. Успевает он прямо посреди хода,
                так что вкладка даже не останавливается. Этим же текстом сворм подталкивает
                вкладку, которая всё-таки встала с вопросом.</span>
            </div>
            <textarea class="set-input set-prose" id="set-night-rule" rows="8" spellcheck="false"></textarea>
            <button type="button" class="set-check-btn" id="set-night-rule-reset" hidden>вернуть заготовку</button>
          </div>
          <div class="set-field">
            <div class="set-head">
              <span class="set-label">Вопрос замолчавшей вкладке</span>
              <button type="button" class="set-q" aria-label="подсказка">?</button>
              <span class="set-hint" hidden>Вкладка закончила ход и две минуты молчит — сворм
                спрашивает её сам: работа кончилась или впереди следующий шаг? Отвечает агент,
                и выбирает он из вариантов, которые вы напишете ему здесь.</span>
            </div>
            <textarea class="set-input set-prose" id="set-night-ask" rows="8" spellcheck="false"></textarea>
            <button type="button" class="set-check-btn" id="set-night-ask-reset" hidden>вернуть заготовку</button>
          </div>
          <div class="set-note" id="set-night-protocol"></div>
          <div class="tg-state" id="set-night-note"></div>
        </section>
      </div>

      <div class="set-panel" data-panel="updates">
        <header class="set-panel-h">
          <h2 class="set-h">Обновления</h2>
          <p class="set-intro">Версия: <b class="upd-cur">…</b> · in-place ok ✓</p>
        </header>
        <section class="set-group">
          <div class="tg-row tg-row-wrap">
            <button class="set-check-btn upd-check">Проверить обновления</button>
            <button class="set-check-btn upd-go-btn" hidden type="button"></button>
          </div>
          <div class="set-note upd-status"></div>
        </section>
      </div>
      </div>

      <div class="modal-actions">
        <button class="modal-cancel">Отмена</button>
        <button class="modal-ok neutral">Сохранить</button>
      </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // Launch panel wiring: mode (agent/blank) + an editable list of commands.
  // Подсказки по пунктам не висят под ними простынёй, а лежат рядом спрятанными: их
  // показывает вопросик. Панель тогда читается списком настроек, а не текстом — а объяснение
  // никуда не делось и открывается там, где на него смотрят.
  //
  // Текст берём из соседнего спрятанного `.set-hint`, а не из атрибута: в подсказках есть
  // разметка (code, перенос, моно), и в атрибуте она превратилась бы в экранированную кашу.
  const tipEl = document.createElement('div');
  tipEl.className = 'set-tip hidden';
  overlay.appendChild(tipEl);
  let tipFor = null;                       // вопросик, чья подсказка открыта сейчас
  const closeTip = () => { tipEl.classList.add('hidden'); tipFor = null; };
  // Подсказка висит НАД панелью и координатами прибита к вопросику, так что прокрутка увезла
  // бы её от хозяина: закрываем.
  overlay.querySelector('.set-body').addEventListener('scroll', () => { if (tipFor) closeTip(); });
  overlay.addEventListener('click', (e) => {
    if (e.target.closest('.set-tip')) return;   // читают/выделяют текст — не мешаем
    const q = e.target.closest('.set-q');
    if (!q) { if (tipFor) closeTip(); return; }
    // Вопросик стоит внутри строки с меткой: без этого клик по нему щёлкал бы галочкой.
    e.preventDefault();
    e.stopPropagation();
    if (tipFor === q) { closeTip(); return; }   // повторный клик закрывает
    const hint = q.nextElementSibling;
    if (!hint || !hint.classList.contains('set-hint')) return;
    tipEl.innerHTML = hint.innerHTML;
    tipEl.classList.remove('hidden');
    placeMenuUnder(tipEl, q);
    tipFor = q;
  });

  const agentBlockEl = overlay.querySelector('#set-agent-block');
  const agentListEl = overlay.querySelector('#set-agent-list');
  const pickFieldEl = overlay.querySelector('#set-pick-field');
  // Режим для новых вкладок. Список приходит из main: подписи режимов живут в screen.js,
  // рядом с их распознаванием на экране, и второй список здесь разошёлся бы с ним молча.
  const permI = overlay.querySelector('#set-perm-mode');
  const permNoteEl = overlay.querySelector('#set-perm-mode-note');
  const permTitles = new Map();
  const syncPermNote = () => {
    permNoteEl.textContent = permI.value
      ? permTitles.get(permI.value) || ''
      : 'Как решит сам Claude Code — обычно спрашивает разрешение.';
  };
  permI.addEventListener('change', syncPermNote);
  window.swarm.listModes().then((modes) => {
    // «Не задавать» первым и по умолчанию: подсовывать всем режим, о котором не просили,
    // нельзя — у режимов разная цена.
    const opts = [{ id: '', title: 'не задавать' }].concat(modes || []);
    permI.innerHTML = '';
    for (const m of opts) {
      permTitles.set(m.id, m.title);
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.title;
      permI.appendChild(o);
    }
    permI.value = permTitles.has(permMode) ? permMode : '';
    syncPermNote();
  });
  // Самоперезапуск: галочка и порог. Границы ползунка приходят из restart.js — того же
  // модуля, по которому main решает «пора спросить», иначе панель обещала бы порог, с
  // которым перезапуск не работает.
  const restartI = overlay.querySelector('#set-restart');
  restartI.checked = restartOn;
  const restartPctI = overlay.querySelector('#set-restart-pct');
  const restartNumEl = overlay.querySelector('#set-restart-pct-num');
  restartPctI.min = String(RESTART_API.MIN_PCT);
  restartPctI.max = String(RESTART_API.MAX_PCT);
  restartPctI.step = '5';
  restartPctI.value = String(restartPct);
  const syncRestart = () => {
    restartNumEl.textContent = restartPctI.value + '%';
    // Выключенная функция не должна выглядеть настраиваемой: серый ползунок объясняет
    // порядок действий сам, без подписи «сначала включите».
    restartPctI.disabled = !restartI.checked;
    restartNumEl.classList.toggle('off', !restartI.checked);
  };
  restartPctI.addEventListener('input', syncRestart);
  restartI.addEventListener('change', syncRestart);
  syncRestart();
  // --- Telegram panel -------------------------------------------------------
  // Everything here applies IMMEDIATELY (like the updates panel), not on «Сохранить»:
  // connecting a bot and binding a chat are actions, not preferences. The token field is
  // write-only — after it's stored we clear the box and show a mask, because the renderer
  // is never given the token back.
  const tgTokenI = overlay.querySelector('#set-tg-token');
  const tgStateEl = overlay.querySelector('#set-tg-state');
  const tgChatField = overlay.querySelector('#set-tg-chat-field');
  const tgPairBox = overlay.querySelector('#set-tg-pair');
  const tgQrI = overlay.querySelector('#set-tg-qr');
  const tgStep2Why = overlay.querySelector('#set-tg-step2-why');
  const tgCodeEl = overlay.querySelector('#set-tg-code');
  const tgLinkA = overlay.querySelector('#set-tg-link');
  const tgTtlEl = overlay.querySelector('#set-tg-ttl');
  const tgUnpairB = overlay.querySelector('#set-tg-unpair');
  const tgPairBtn = overlay.querySelector('#set-tg-pair-btn');
  const tgReconnectB = overlay.querySelector('#set-tg-reconnect');
  const tgCheckB = overlay.querySelector('#set-tg-check');
  const tgCheckNote = overlay.querySelector('#set-tg-check-note');
  const tgChecksEl = overlay.querySelector('#set-tg-checks');
  const tgStep3 = overlay.querySelector('#set-tg-step3');
  const tgLiveEl = overlay.querySelector('#set-tg-live');
  const tgMark1 = overlay.querySelector('#set-tg-mark1');
  const tgMark2 = overlay.querySelector('#set-tg-mark2');
  const tgMark3 = overlay.querySelector('#set-tg-mark3');
  const tgTrouble = overlay.querySelector('#set-tg-trouble');
  const tgExtra = overlay.querySelector('#set-tg-extra');
  const tgDetailShort = overlay.querySelector('#set-tg-detail-short');
  const tgDetailFull = overlay.querySelector('#set-tg-detail-full');
  const tgDetailCustom = overlay.querySelector('#set-tg-detail-custom');
  const tgPromptBox = overlay.querySelector('#set-tg-prompt-box');
  const tgPromptI = overlay.querySelector('#set-tg-prompt');
  const tgAwakeI = overlay.querySelector('#set-tg-awake');
  const tgWBinI = overlay.querySelector('#set-tg-wbin');
  const tgWModelI = overlay.querySelector('#set-tg-wmodel');
  const tgVoiceHintEl = overlay.querySelector('#set-tg-voice-hint');
  const vModelSel = overlay.querySelector('#set-voice-model');
  const vInstallB = overlay.querySelector('#set-voice-install');
  const vCancelB = overlay.querySelector('#set-voice-cancel');
  const vRemoveB = overlay.querySelector('#set-voice-remove');
  const vProgress = overlay.querySelector('#set-voice-progress');
  const vBar = overlay.querySelector('#set-voice-bar');
  const vNote = overlay.querySelector('#set-voice-note');
  const vManualB = overlay.querySelector('#set-voice-manual');
  const vManualBox = overlay.querySelector('#set-voice-manual-box');
  let tgTtlTimer = null;

  const vMb = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' ГБ' : Math.round((n || 0) / 1e6) + ' МБ');

  // Голос одной кнопкой. Всё состояние приходит из main вместе с остальным состоянием
  // Телеграма, поэтому полоса прогресса живёт сама — отдельного канала событий нет.
  function renderVoice(st) {
    const v = st.voice || {};
    const models = v.models || [];
    if (vModelSel.options.length !== models.length) {
      vModelSel.innerHTML = '';
      for (const m of models) {
        const o = document.createElement('option');
        o.value = m.id;
        // В подписи — и вес, и смысл: без этого «Обычная — 148 МБ» не отвечает на вопрос
        // «а что я вообще выбираю».
        o.textContent = `${m.label}, ${vMb(m.bytes)} — ${m.note || ''}`.replace(/ — $/, '');
        o.title = m.note || '';
        if (m.recommended) o.selected = true;
        vModelSel.appendChild(o);
      }
    }
    if (v.model && !v.busy) vModelSel.value = v.model;
    const ready = !!(st.voiceReady && v.managed);
    vModelSel.disabled = !!v.busy;
    vInstallB.hidden = !!v.busy;
    vInstallB.textContent = ready ? 'Сменить модель' : 'Включить голосовые';
    vCancelB.hidden = !v.busy;
    vRemoveB.hidden = !!v.busy || !v.diskBytes;
    vRemoveB.textContent = v.diskBytes ? `Удалить (${vMb(v.diskBytes)})` : 'Удалить';
    vProgress.hidden = !v.busy;
    // Пока total неизвестен (ещё качаем список сборок) — полоса не врёт нулём, а ждёт.
    vBar.style.width = v.busy && v.total ? Math.round((v.done / v.total) * 100) + '%' : '0%';
    if (v.busy) {
      vNote.textContent = v.total
        ? `Качаю ${v.what}: ${vMb(v.done)} из ${vMb(v.total)}`
        : 'Готовлюсь…';
      vNote.className = 'tg-state';
    } else if (v.error) {
      vNote.textContent = '⚠ ' + v.error;
      vNote.className = 'tg-state is-bad';
    } else if (st.voiceReady) {
      vNote.textContent = v.managed
        ? `Голосовые работают: модель ${v.model}, распознавание на этой машине.`
        : 'Голосовые работают: whisper.cpp настроен вручную.';
      vNote.className = 'tg-state is-good';
    } else {
      vNote.textContent = 'Голосовые пока не распознаются. Нажми «Включить голосовые» —'
        + ' скачается распознаватель и модель, звук останется на этой машине.';
      vNote.className = 'tg-state';
    }
  }

  vInstallB.addEventListener('click', async () => { renderTg(await window.swarm.voiceInstall(vModelSel.value)); });
  vCancelB.addEventListener('click', async () => { renderTg(await window.swarm.voiceCancel()); });
  vRemoveB.addEventListener('click', async () => { renderTg(await window.swarm.voiceRemove()); });
  // Журнал пишется всегда, поэтому его надо просто показать — включать нечего.
  overlay.querySelector('#set-tg-log').addEventListener('click', () => { window.swarm.showTgLog(); });
  vManualB.addEventListener('click', () => {
    vManualBox.hidden = !vManualBox.hidden;
    vManualB.textContent = vManualBox.hidden ? 'Указать пути вручную' : 'Скрыть пути';
  });

  // Состояние шага одним знаком. Троичное, как и сами проверки: «не знаю» — это не «плохо»,
  // и рисовать крестик там, где мы просто ещё не спрашивали, значит посылать чинить не то.
  function tgMark(el, ok) {
    el.textContent = ok === true ? '✓' : ok === false ? '✗' : '';
    el.className = 'tg-step-mark' + (ok === true ? ' is-good' : ok === false ? ' is-bad' : '');
  }

  // Живой список проверок группы: видно всё сразу — что уже сделано, что осталось. Раньше
  // здесь была одна фраза про первую же беду, и настройка шла вслепую, по одной проблеме за
  // нажатие «проверить».
  function renderChecks(check) {
    const list = (check && check.checks) || [];
    tgChecksEl.hidden = !list.length;
    tgChecksEl.innerHTML = '';
    for (const c of list) {
      const li = document.createElement('li');
      li.className = 'tg-check' + (c.ok === true ? ' is-good' : c.ok === false ? (c.soft ? ' is-warn' : ' is-bad') : '');
      const mark = document.createElement('span');
      mark.className = 'tg-check-mark';
      mark.textContent = c.ok === true ? '✓' : c.ok === false ? (c.soft ? '!' : '✗') : '·';
      const tx = document.createElement('span');
      tx.textContent = c.label;
      li.append(mark, tx);
      tgChecksEl.appendChild(li);
    }
  }

  function tgTokenText(st) {
    if (!st.configured) return 'Бот не подключён';
    if (st.error) return '⚠ ' + st.error;
    return st.bot ? `Бот @${st.bot} подключён` : 'Токен принят';
  }

  function tgLiveText(st) {
    if (st.error) return '⚠ ' + st.error;
    if (!st.live) return 'Опрос не идёт — нажмите «Подключить заново».';
    // Название группы, если оно известно: «привязана» без имени не даёт убедиться, что это
    // та самая группа, особенно когда их несколько.
    const where = st.check && st.check.title ? ` «${st.check.title}»` : '';
    return `Мост работает: группа${where} на связи, вкладки получают свои темы.`;
  }

  function renderTg(st) {
    if (!st) return;
    const bound = st.chatId != null;
    const groupOk = bound && !!(st.check ? st.check.ok : true);
    tgStateEl.textContent = tgTokenText(st);
    tgStateEl.className = 'tg-state' + (st.error ? ' is-bad' : st.configured ? ' is-good' : '');
    tgMark(tgMark1, st.configured ? (st.error ? false : true) : null);
    tgMark(tgMark2, !bound ? null : st.check ? (st.check.ok ? true : false) : true);
    tgMark(tgMark3, !bound ? null : st.live && !st.error ? true : false);
    tgTokenI.placeholder = st.configured ? st.masked : '1234567890:AA…';
    tgChatField.hidden = !st.configured;
    // Третий шаг — про то, что мост уже живёт; до привязки группы показывать нечего.
    tgStep3.hidden = !bound;
    tgLiveEl.textContent = bound ? tgLiveText(st) : '';
    tgLiveEl.className = 'tg-state' + (!bound ? '' : st.live && !st.error ? ' is-good' : ' is-bad');
    tgTrouble.hidden = !st.configured;
    tgUnpairB.hidden = !bound;
    // Опрос лежит, хотя бот подключён: единственный выход из фатальной ошибки (не тот токен,
    // «токен уже читает кто-то другой») раньше был перезапуск приложения.
    tgReconnectB.hidden = !st.configured || !!st.live;
    tgCheckB.hidden = !bound;
    renderChecks(bound ? st.check : null);
    // Настройки моста — только когда мосту есть куда писать. До этого они обещают
    // управление тем, чего ещё нет.
    tgExtra.hidden = !groupOk;
    const detail = (st.detail === 'full' || st.detail === 'custom') ? st.detail : 'short';
    tgDetailShort.checked = detail === 'short';
    tgDetailFull.checked = detail === 'full';
    tgDetailCustom.checked = detail === 'custom';
    // Поле своей формулировки открыто ровно тогда, когда она в силе: закрытое поле с текстом
    // внутри — это и был прежний обман, когда выбранным стояло «кратко», а работала своя строка.
    tgPromptBox.hidden = detail !== 'custom';
    // Привязались — код мёртв, и висящий QR только вводит в заблуждение («битый»).
    if (st.chatId != null) {
      stopTgTtl();
      tgPairBox.hidden = true;
      // И убираем саму картинку: иначе она остаётся в DOM и всплывает битой, если панель
      // покажут снова.
      tgQrI.hidden = true;
      tgQrI.removeAttribute('src');
    }
    // Шаг 2 объясняет, КАК привязать группу. Когда она уже привязана, объяснение только
    // отвлекает — вместо него видно, что именно привязано.
    tgStep2Why.hidden = st.chatId != null;
    tgPairBtn.textContent = st.chatId == null ? 'Привязать группу' : 'Привязать другую';
    // Подсказка «что чинить» — только когда чинить есть что: рядом со списком галочек фраза
    // «бот администратор, темы доступны» повторяет его же и превращается в шум.
    const needsWork = !!(st.check && (st.check.checks || []).some((c) => c.ok === false));
    tgCheckNote.textContent = needsWork ? st.check.note : '';
    tgCheckNote.className = 'tg-state' + (needsWork && !st.check.ok ? ' is-bad' : '');
    if (document.activeElement !== tgPromptI) tgPromptI.value = st.prompt || '';
    tgPromptI.placeholder = st.promptDefault || '';
    tgAwakeI.checked = !!st.keepAwake;
    // Панель и кнопка в строке состояния показывают одно и то же состояние моста. Отвязка
    // группы отвечает только сюда (main её не рассылает), а кнопка при этом должна исчезнуть.
    renderPresencePill(st);
    if (document.activeElement !== tgWBinI) tgWBinI.value = st.whisperBin || '';
    if (document.activeElement !== tgWModelI) tgWModelI.value = st.whisperModel || '';
    // Инструкция по ручной установке — своя на ОС (brew есть только на маке), её присылает
    // main. Обычному пути она не нужна, поэтому лежит внутри скрытого блока «уже есть
    // whisper.cpp», а не пугает всех остальных.
    tgVoiceHintEl.textContent = st.voiceHint || '';
    renderVoice(st);
  }

  function stopTgTtl() {
    if (tgTtlTimer) { clearInterval(tgTtlTimer); tgTtlTimer = null; }
  }

  const setDetail = async (d) => {
    renderTg(await window.swarm.telegram.setDetail(d));
    // Выбрал «свою» — курсор сразу в поле: без этого положение выбрано, а сказать в нём нечего,
    // и следующий шаг человеку приходится искать глазами.
    if (d === 'custom') tgPromptI.focus();
  };
  tgDetailShort.addEventListener('change', () => { if (tgDetailShort.checked) setDetail('short'); });
  tgDetailFull.addEventListener('change', () => { if (tgDetailFull.checked) setDetail('full'); });
  tgDetailCustom.addEventListener('change', () => { if (tgDetailCustom.checked) setDetail('custom'); });

  window.swarm.telegram.state().then(async (st) => {
    renderTg(st);
    // Права в группе могли поменяться, пока приложение не смотрело (бота разжаловали,
    // добавили право). Перепроверяем сами, один раз за запуск: мастер обещает показывать
    // положение дел, а не то, что было верно на прошлой привязке.
    if (st && st.chatId != null && !st.check) renderTg(await window.swarm.telegram.check());
  });
  // Main pushes state on its own too (the poller losing the network, a chat pairing
  // itself from the phone) — the panel must not need a reopen to notice.
  window.swarm.telegram.onState((st) => { if (document.body.contains(overlay)) renderTg(st); });

  // --- Ночь: свои формулировки -------------------------------------------------------------
  // Заготовка лежит в поле ЗНАЧЕНИЕМ, и это здесь главное. Раньше она стояла подсказкой
  // (placeholder) — так пустое поле честно значило «как у сворма», и отличать своё от нетронутого
  // не приходилось вовсе. Но подсказку нельзя ПРАВИТЬ: чтобы поменять в правиле одно слово, человек
  // должен был перепечатать шестьсот символов руками, и «слегка поменять» превращалось в работу
  // переписчика. Никто этого не делал.
  //
  // Теперь текст видно и правят его как обычный, а «как у сворма» считается сравнением: совпал с
  // заготовкой — сохраняем пусто, и текст продолжит обновляться вместе со свормом, как и раньше.
  // Кнопка «вернуть заготовку» делает то же самое одним нажатием и стоит только там, где есть что
  // возвращать: при заготовке в поле возвращать нечего.
  const nightRuleI = overlay.querySelector('#set-night-rule');
  const nightAskI = overlay.querySelector('#set-night-ask');
  const nightNote = overlay.querySelector('#set-night-note');
  const nightProtocolEl = overlay.querySelector('#set-night-protocol');
  const nightResets = { rule: overlay.querySelector('#set-night-rule-reset'), ask: overlay.querySelector('#set-night-ask-reset') };
  const nightFields = { rule: nightRuleI, ask: nightAskI };
  const nightDefaults = { rule: '', ask: '' };
  // Сравниваем так же, как main чистит текст перед сохранением (night:setTexts): иначе лишний
  // перенос строки делал бы правку «своим текстом», ничего в ней не поменяв.
  const flatText = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

  function renderNightTexts(st) {
    if (!st) return;
    nightDefaults.rule = st.ruleDefault || '';
    nightDefaults.ask = st.askDefault || '';
    // Поле под курсором не трогаем: человек в нём печатает.
    if (document.activeElement !== nightRuleI) nightRuleI.value = st.rule || nightDefaults.rule;
    if (document.activeElement !== nightAskI) nightAskI.value = st.ask || nightDefaults.ask;
    nightResets.rule.hidden = !st.rule;
    nightResets.ask.hidden = !st.ask;
    // Служебную строку ПОКАЗЫВАЕМ, но не даём править: агент должен знать, чем звать человека,
    // а человек — что эта строка есть и уедет в любом случае. Спрятать её значило бы врать про
    // то, что получит агент; положить в поле — вернуть ловушку, из-за которой она оттуда и уехала.
    // Дописок две, и обе показываем: строка про метку зова уезжает к обоим текстам, просьба
    // про итог — только к вопросу (night.askText), и по ней же вкладка отмечается сдавшей
    // работу. Человек должен знать про обе — он правит текст, к которому их припишут.
    nightProtocolEl.textContent = [
      st.protocol ? `К обоим текстам сворм всегда добавит: «${st.protocol}»` : '',
      st.summary ? `А к вопросу — просьбу про итог: «${st.summary}»` : '',
    ].filter(Boolean).join(' ');
    const own = [st.rule ? 'правило' : '', st.ask ? 'вопрос' : ''].filter(Boolean);
    nightNote.textContent = own.length
      ? `Свой текст: ${own.join(' и ')}.`
      : 'Сейчас оба текста — заготовки сворма.';
  }

  async function saveNightText(key) {
    const typed = flatText(nightFields[key].value);
    const same = typed === flatText(nightDefaults[key]);
    renderNightTexts(await window.swarm.night.setTexts({ [key]: same ? '' : typed }));
  }

  window.swarm.night.state().then(renderNightTexts).catch(() => {});
  for (const key of ['rule', 'ask']) {
    nightFields[key].addEventListener('change', () => { saveNightText(key).catch(() => {}); });
    nightResets[key].addEventListener('click', async () => {
      renderNightTexts(await window.swarm.night.setTexts({ [key]: '' }));
    });
  }

  overlay.querySelector('#set-tg-save').addEventListener('click', async () => {
    const token = tgTokenI.value.trim();
    if (!token) return;
    tgStateEl.textContent = 'Проверяю токен…';
    const st = await window.swarm.telegram.setToken(token);
    tgTokenI.value = '';            // the secret does not linger in the DOM
    renderTg(st);
  });

  tgPairBtn.addEventListener('click', async () => {
    const r = await window.swarm.telegram.pair();
    if (!r || r.error) { tgStateEl.textContent = '⚠ ' + ((r && r.error) || 'не получилось'); return; }
    // Картинку показываем ТОЛЬКО когда есть что показать: <img> без src — это «битая
    // картинка» в панели, и ровно её видел пользователь при уже привязанной группе.
    if (r.qr) { tgQrI.src = r.qr; tgQrI.hidden = false; } else { tgQrI.hidden = true; }
    tgCodeEl.textContent = r.code;
    tgLinkA.href = r.link;
    tgPairBox.hidden = false;
    const until = Date.now() + r.ttlMs;
    stopTgTtl();
    const tick = () => {
      const left = Math.max(0, Math.round((until - Date.now()) / 1000));
      tgTtlEl.textContent = left
        ? `код действует ещё ${left > 90 ? Math.ceil(left / 60) + ' мин' : left + ' с'}`
        : 'код истёк — нажмите «Привязать группу» снова';
      if (!left) { stopTgTtl(); tgPairBox.hidden = true; }
    };
    tick();
    tgTtlTimer = setInterval(tick, 1000);
  });

  tgUnpairB.addEventListener('click', async () => {
    renderTg(await window.swarm.telegram.unpair());
  });

  tgCheckB.addEventListener('click', async () => {
    tgCheckNote.textContent = 'Проверяю…';
    tgCheckNote.className = 'tg-state';
    renderTg(await window.swarm.telegram.check());
  });

  tgReconnectB.addEventListener('click', async () => {
    tgStateEl.textContent = 'Подключаюсь заново…';
    renderTg(await window.swarm.telegram.reconnect());
  });

  overlay.querySelector('#set-tg-bf').addEventListener('click', (e) => {
    e.preventDefault();
    window.swarm.openExternal('https://t.me/BotFather');
  });

  // Both apply on blur, not on «Сохранить» — same as the rest of this panel.
  tgPromptI.addEventListener('change', async () => {
    renderTg(await window.swarm.telegram.setPrompt(tgPromptI.value));
  });
  const saveWhisper = async () => {
    renderTg(await window.swarm.telegram.setWhisper(tgWBinI.value, tgWModelI.value));
  };
  tgWBinI.addEventListener('change', saveWhisper);
  tgWModelI.addEventListener('change', saveWhisper);
  tgAwakeI.addEventListener('change', async () => {
    renderTg(await window.swarm.telegram.keepAwake(tgAwakeI.checked));
  });

  overlay.querySelector('#set-tg-forget').addEventListener('click', async () => {
    stopTgTtl();
    tgPairBox.hidden = true;
    tgTokenI.value = '';
    renderTg(await window.swarm.telegram.forget());
  });
  const pultI = overlay.querySelector('#set-pult');
  pultI.checked = pultEnabled;

  // The pick-mode choice only matters with more than one command — hide otherwise.
  const countAgents = () => [...agentListEl.querySelectorAll('.agent-cmd')]
    .filter((i) => i.value.trim()).length;
  const syncPickVisibility = () => {
    pickFieldEl.classList.toggle('hidden', countAgents() <= 1);
  };
  // One line per command ("cmd --flags"); split on save.
  const addAgentRow = (agent = { cmd: '', flags: '' }) => {
    const row = document.createElement('div');
    row.className = 'agent-row';
    row.innerHTML = `
      <input class="set-input agent-cmd" type="text" spellcheck="false"
             autocapitalize="off" autocorrect="off" placeholder="claude --model sonnet" />
      <button type="button" class="agent-del" title="Удалить" aria-label="удалить">×</button>`;
    row.querySelector('.agent-cmd').value = agentLabel(agent);
    row.querySelector('.agent-del').addEventListener('click', () => {
      row.remove();
      syncPickVisibility();
    });
    row.querySelector('.agent-cmd').addEventListener('input', syncPickVisibility);
    agentListEl.appendChild(row);
    return row;
  };

  launchList.forEach((a) => addAgentRow(a));
  overlay.querySelector('#set-agent-add').addEventListener('click', () => {
    addAgentRow().querySelector('.agent-cmd').focus();
  });
  overlay.querySelectorAll('input[name="set-pick"]').forEach((r) => { r.checked = r.value === launchPick; });
  syncPickVisibility();

  // Mode radios: the whole agent block is irrelevant in "clean terminal" mode.
  const syncModeVisibility = () => {
    const blank = overlay.querySelector('input[name="set-mode"]:checked')?.value === 'blank';
    agentBlockEl.classList.toggle('hidden', blank);
  };
  overlay.querySelectorAll('input[name="set-mode"]').forEach((r) => {
    r.checked = r.value === launchMode;
    r.addEventListener('change', syncModeVisibility);
  });
  syncModeVisibility();

  // Notify panel wiring: the sub-options grey out when the master is off.
  const onI = overlay.querySelector('#set-notify-on');
  const readyI = overlay.querySelector('#set-notify-ready');
  const waitingI = overlay.querySelector('#set-notify-waiting');
  const activeI = overlay.querySelector('#set-notify-active');
  const soundI = overlay.querySelector('#set-notify-sound');
  onI.checked = notifyEnabled;
  readyI.checked = notifyOnReady;
  waitingI.checked = notifyOnWaiting;
  activeI.checked = notifyActive;
  soundI.checked = notifySound;
  // По id, а не по классу: «.set-sub» в панели не один (порог самоперезапуска — второй такой
  // блок, и в разметке он ВЫШЕ), а querySelector отдаёт первый совпавший. С классом главный
  // выключатель уведомлений гасил бы чужую настройку и не гасил свою.
  const syncNotify = () => {
    overlay.querySelector('#set-notify-sub').classList.toggle('disabled', !onI.checked);
  };
  syncNotify();
  onI.addEventListener('change', syncNotify);

  // Appearance panel. Edits accumulate in `draft` (a copy of the live appearance)
  // and only commit on Save — Cancel/Esc discards them. A small preview strip
  // reflects the draft immediately, before saving.
  const draft = { ...appearance };
  const themeSel = overlay.querySelector('#set-theme');
  const fontVal = overlay.querySelector('#set-font-val');
  const fontDec = overlay.querySelector('#set-font-dec');
  const fontInc = overlay.querySelector('#set-font-inc');
  const familySel = overlay.querySelector('#set-font-family');
  const cursorSel = overlay.querySelector('#set-cursor-style');
  const blinkI = overlay.querySelector('#set-cursor-blink');
  const previewEl = overlay.querySelector('#set-term-preview');

  // Тема — селектом, а не плитками. Плитки показывали пять цветных полосок из
  // палитры темы, и по ним нельзя было понять НИЧЕГО: какой цвет чему достанется,
  // видно только в предпросмотре. Он тут один и он же и есть выбор темы.
  APPEARANCE.THEMES.forEach((t) => {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.name;
    themeSel.appendChild(o);
  });
  themeSel.value = draft.theme;
  themeSel.addEventListener('change', () => { draft.theme = themeSel.value; renderTermPreview(); });

  APPEARANCE.FONT_FAMILIES.forEach((f) => {
    const o = document.createElement('option');
    o.value = f.value;
    o.textContent = f.name;
    familySel.appendChild(o);
  });
  familySel.value = draft.fontFamily; // no-op if the stored stack isn't in the list

  APPEARANCE.CURSOR_STYLES.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name;
    cursorSel.appendChild(o);
  });
  cursorSel.value = draft.cursorStyle;
  blinkI.checked = draft.cursorBlink;

  function renderTermPreview() {
    const xt = APPEARANCE.getTheme(draft.theme).xterm;
    previewEl.style.background = xt.background;
    previewEl.style.color = xt.foreground;
    previewEl.style.fontFamily = draft.fontFamily;
    previewEl.style.fontSize = draft.fontSize + 'px';
    fontVal.textContent = draft.fontSize;
    const cur = draft.cursorStyle === 'bar' ? '▏' : draft.cursorStyle === 'underline' ? '_' : '█';
    // Предпросмотр — не образец шрифта, а ответ на вопрос «что каким цветом будет»:
    // путь, ветка, команда, успех, предупреждение, ошибка, курсор. Ровно то, на что
    // человек смотрит в терминале, и в тех же ролях.
    previewEl.innerHTML = [
      `<span style="color:${xt.cyan}">~/project</span> ` +
        `<span style="color:${xt.magenta}">main</span> $ ` +
        `<span style="color:${xt.foreground}">claude --model sonnet</span>`,
      `<span style="color:${xt.green}">✓ готово: 3 файла</span>   ` +
        `<span style="color:${xt.yellow}">! тесты не запускались</span>`,
      `<span style="color:${xt.red}">✗ ошибка: модуль не найден</span>`,
      `Сейчас от тебя: выбрать вариант ` +
        `<span class="prev-cur" style="color:${xt.cursor}">${cur}</span>`,
    ].join('\n');
  }
  renderTermPreview();

  const setFont = (n) => { draft.fontSize = Math.max(10, Math.min(20, n)); renderTermPreview(); };
  fontDec.addEventListener('click', () => setFont(draft.fontSize - 1));
  fontInc.addEventListener('click', () => setFont(draft.fontSize + 1));
  familySel.addEventListener('change', () => { draft.fontFamily = familySel.value; renderTermPreview(); });
  cursorSel.addEventListener('change', () => { draft.cursorStyle = cursorSel.value; renderTermPreview(); });
  blinkI.addEventListener('change', () => { draft.cursorBlink = blinkI.checked; });

  // Tabs panel. Same draft pattern as appearance: edits land in tabDraft and only
  // commit on Save. normalizeTabStyle doubles as the deep copy — a spread would
  // share the nested show/colors objects with the live tabstyle and leak edits.
  const tabDraft = TABSTYLE.normalizeTabStyle(tabstyle);
  const densitySel = overlay.querySelector('#set-tab-density');
  const statusSel = overlay.querySelector('#set-tab-status');
  const showInputs = {
    ctx: overlay.querySelector('#set-tab-ctx'),
    sub: overlay.querySelector('#set-tab-sub'),
  };
  const colorRow = overlay.querySelector('#set-tab-colors');
  const tabPreviewEl = overlay.querySelector('#set-tab-preview');

  TABSTYLE.DENSITIES.forEach((d) => {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.name;
    densitySel.appendChild(o);
  });
  densitySel.value = tabDraft.density;

  TABSTYLE.STATUS_STYLES.forEach((x) => {
    const o = document.createElement('option');
    o.value = x.id;
    o.textContent = x.name;
    statusSel.appendChild(o);
  });
  statusSel.value = tabDraft.status;

  // Раскладка — ЧЕРНОВИК, как и всё остальное в этой панели: применяется по
  // «Сохранить», отмена её не трогает.
  //
  // Раньше она применялась сразу, и объяснялось это тем, что ⌘L может переключить
  // раскладку при открытой модалке — тогда «Сохранить» вернуло бы её назад. Но цена
  // была не та: в панели с кнопкой «Сохранить» одна настройка молча срабатывала на
  // выбор, и отменить её было нечем — «Отмена» откатывала всё, кроме неё. Заглянуть
  // в вариант, чтобы посмотреть, стало необратимым действием.
  // Конфликт с ⌘L решён не порядком применения, а связью: applyLayout зовёт
  // onLayoutApplied, и селект едет за клавиатурой (см. currentLayout выше).
  let layoutDraft = currentLayout();
  const layoutSel = overlay.querySelector('#set-layout');
  LAYOUT_LABELS.forEach(({ id, name }) => {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = name;
    layoutSel.appendChild(o);
  });
  layoutSel.value = layoutDraft;
  layoutSel.addEventListener('change', () => { layoutDraft = layoutSel.value; renderTabPreview(); });
  // ⌘L при открытой панели: раскладка в бою поехала — селект и превью едут за ней.
  onLayoutApplied = (name) => {
    layoutDraft = name;
    layoutSel.value = name;
    renderTabPreview();
  };

  Object.keys(showInputs).forEach((k) => { showInputs[k].checked = tabDraft.show[k]; });

  // Три карточки, потому что меньше не показывает главного: открытая и работающая
  // (кольцо теперь цвета её статуса, а не бирюзовое), спокойная готовая и зовущая
  // «ждёт ввода» — рядом видно, что открытая и зовущая больше не близнецы.
  // Written once — renderTabPreview only restyles.
  // Превью 1:1 с боем: та же разметка, что строит createSession/relayoutTabs —
  // включая вкладку Пульта с каунтером и угловую капсулу с кнопками. Ширина/высота ведут
  // себя как реальные (см. renderTabPreview: класс раскладки берётся из боя).
  tabPreviewEl.innerHTML =
    `<div class="pult-tab">
       <span class="pult-name">Пульт</span>
       <span class="pult-count">2</span>
     </div>
     <div class="tab active status-running">
       <span class="grip">${ICONS.grip}</span>
       <span class="dot"></span>
       <span class="body">
         <span class="label">api</span>
         <span class="ctx ctx-mid"><span class="ctx-track"><span class="ctx-fill" style="width:62%"></span></span><span class="ctx-num">62%</span></span>
         <span class="foot">
           <span class="sub">работает</span>
           <span class="agents">${ICONS.agents}<span class="agents-num">3</span></span>
         </span>
       </span>
       ${tabTools()}
     </div>
     <div class="tab status-ready">
       <span class="grip">${ICONS.grip}</span>
       <span class="dot"></span>
       <span class="body">
         <span class="label">web</span>
         <span class="ctx ctx-lo"><span class="ctx-track"><span class="ctx-fill" style="width:14%"></span></span><span class="ctx-num">14%</span></span>
         <span class="foot">
           <span class="sub">готов</span>
         </span>
       </span>
       ${tabTools()}
     </div>
     <div class="tab status-waiting">
       <span class="grip">${ICONS.grip}</span>
       <span class="dot"></span>
       <span class="body">
         <span class="label">docs</span>
         <span class="ctx ctx-lo"><span class="ctx-track"><span class="ctx-fill" style="width:31%"></span></span><span class="ctx-num">31%</span></span>
         <span class="foot">
           <span class="sub">ждёт ответа</span>
         </span>
       </span>
       ${tabTools()}
     </div>`;

  function renderTabPreview() {
    const vars = TABSTYLE.toCssVars(tabDraft);
    for (const k of Object.keys(vars)) tabPreviewEl.style.setProperty(k, vars[k]);
    // Раскладка превью = ЧЕРНОВИК, а не то, что сейчас в бою: пока раскладка
    // применялась сразу, это было одно и то же, а теперь превью — единственное место,
    // где выбранную раскладку видно до нажатия «Сохранить».
    tabPreviewEl.className = 'tab-preview ' + layoutDraft + ' ' + TABSTYLE.bodyClasses(tabDraft).join(' ');
  }

  function renderColorPickers() {
    colorRow.innerHTML = '';
    TABSTYLE.COLORS.forEach((c) => {
      const cell = document.createElement('label');
      cell.className = 'color-cell';
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = tabDraft.colors[c.key];
      inp.addEventListener('input', () => {
        tabDraft.colors[c.key] = inp.value;
        renderTabPreview();
      });
      const name = document.createElement('span');
      name.textContent = c.name;
      cell.appendChild(inp);
      cell.appendChild(name);
      colorRow.appendChild(cell);
    });
  }

  renderColorPickers();
  renderTabPreview();

  densitySel.addEventListener('change', () => {
    tabDraft.density = densitySel.value;
    renderTabPreview();
  });
  Object.keys(showInputs).forEach((k) => {
    showInputs[k].addEventListener('change', () => {
      tabDraft.show[k] = showInputs[k].checked;
      renderTabPreview();
    });
  });
  statusSel.addEventListener('change', () => { tabDraft.status = statusSel.value; renderTabPreview(); });
  overlay.querySelector('#set-tab-colors-reset').addEventListener('click', () => {
    tabDraft.colors = { ...TABSTYLE.DEFAULT_TABSTYLE.colors };
    renderColorPickers();
    renderTabPreview();
  });

  // Keys panel: draft copy of keybinds; capture mode records a new chord/scope.
  const kbDraft = { ...keybinds };
  const kbList = overlay.querySelector('#set-kb-list');
  let kbCapturing = null; // action id while waiting for a key, or null
  let kbCaptureHandler = null;

  function stopKbCapture() {
    if (kbCaptureHandler) {
      document.removeEventListener('keydown', kbCaptureHandler, true);
      kbCaptureHandler = null;
    }
    kbCapturing = null;
    overlay.classList.remove('kb-capturing');
    renderKbList();
  }

  function startKbCapture(actionId) {
    stopKbCapture();
    kbCapturing = actionId;
    overlay.classList.add('kb-capturing');
    renderKbList();
    const action = KEYBINDS_API.ACTIONS.find((a) => a.id === actionId);
    kbCaptureHandler = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.key === 'Escape') { stopKbCapture(); return; }

      if (action && action.kind === 'scope') {
        const scope = KEYBINDS_API.scopeFromEvent(ev);
        if (!scope) return; // need at least one modifier
        // Reject if it would collide with the other scope.
        const otherId = actionId === 'word' ? 'line' : 'word';
        if (kbDraft[otherId] && KEYBINDS_API.modsEqual(scope, kbDraft[otherId])) {
          const btn = kbList.querySelector(`[data-kb="${actionId}"] .kb-chord`);
          if (btn) { btn.textContent = 'совпадает с другим'; btn.classList.add('kb-err'); }
          return;
        }
        kbDraft[actionId] = scope;
        stopKbCapture();
        return;
      }

      const chord = KEYBINDS_API.chordFromEvent(ev);
      if (!chord) return; // modifier-only
      if (KEYBINDS_API.isReserved(chord)) {
        const btn = kbList.querySelector(`[data-kb="${actionId}"] .kb-chord`);
        if (btn) { btn.textContent = 'занято приложением'; btn.classList.add('kb-err'); }
        return;
      }
      kbDraft[actionId] = chord;
      stopKbCapture();
    };
    document.addEventListener('keydown', kbCaptureHandler, true);
  }

  function renderKbList() {
    kbList.innerHTML = '';
    for (const a of KEYBINDS_API.ACTIONS) {
      const row = document.createElement('div');
      row.className = 'kb-row';
      row.dataset.kb = a.id;
      const chordBtn = document.createElement('button');
      chordBtn.type = 'button';
      chordBtn.className = 'kb-chord' + (kbCapturing === a.id ? ' capturing' : '');
      if (kbCapturing === a.id) {
        chordBtn.textContent = a.kind === 'scope' ? 'Модификатор…' : 'Нажмите…';
      } else if (!kbDraft[a.id]) {
        chordBtn.textContent = 'не задано';
      } else {
        const parts = KEYBINDS_API.bindingParts(a.id, kbDraft[a.id], window.swarm.platform);
        parts.forEach((p, i) => {
          if (i) {
            const sep = document.createElement('span');
            sep.className = 'kb-sep';
            sep.textContent = '+';
            chordBtn.appendChild(sep);
          }
          const kbd = document.createElement('kbd');
          kbd.className = 'kb-key';
          kbd.textContent = p;
          chordBtn.appendChild(kbd);
        });
      }
      chordBtn.addEventListener('click', () => {
        if (kbCapturing === a.id) stopKbCapture();
        else startKbCapture(a.id);
      });
      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'kb-reset';
      resetBtn.title = 'Сбросить к умолчанию';
      resetBtn.textContent = '×';
      resetBtn.addEventListener('click', () => {
        kbDraft[a.id] = { ...KEYBINDS_API.defaultsFor(window.swarm.platform)[a.id] };
        if (kbCapturing === a.id) stopKbCapture();
        else renderKbList();
      });
      const label = document.createElement('span');
      label.className = 'kb-label';
      label.textContent = a.label;
      row.appendChild(label);
      row.appendChild(chordBtn);
      row.appendChild(resetBtn);
      kbList.appendChild(row);
    }
  }
  renderKbList();

  const curEl = overlay.querySelector('.upd-cur');
  window.swarm.getVersion().then((v) => { if (curEl) curEl.textContent = v; }).catch(() => {});
  const updStatus = overlay.querySelector('.upd-status');
  const updGoBtn = overlay.querySelector('.upd-go-btn');

  function syncUpdGoBtn(res) {
    const available = res && res.kind !== 'none';
    updGoBtn.hidden = !available;
    if (available) {
      updGoBtn.textContent = res.kind === 'asar'
        ? ('Обновить до ' + res.version)
        : ('Скачать установщик ' + res.version);
    }
  }
  // If a check already found an update (pill is showing), offer the button immediately.
  syncUpdGoBtn(updateState);

  overlay.querySelector('.upd-check').addEventListener('click', async () => {
    updGoBtn.hidden = true;
    updStatus.textContent = 'Проверяю…';
    const res = await checkForUpdate(false);
    if (res && res.kind === 'offline') {
      updStatus.textContent = 'Не удалось проверить — нет связи.';
      syncUpdGoBtn(updateState); // про уже найденное обновление, если оно было, не забываем
    } else if (res && res.kind !== 'none') {
      updStatus.textContent = 'Доступно обновление ' + res.version;
      syncUpdGoBtn(res);
    } else {
      updStatus.textContent = 'Установлена последняя версия.';
    }
  });

  // Tab switching.
  const panels = overlay.querySelectorAll('.set-panel');
  const tabs = overlay.querySelectorAll('.set-tab');
  const showTab = (name) => {
    if (kbCapturing) stopKbCapture();
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    panels.forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
    if (name === 'launch') { const f = agentListEl.querySelector('.agent-cmd'); if (f) { f.focus(); f.select(); } }
  };
  tabs.forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  showTab(['notify', 'appearance', 'tabs', 'keys', 'telegram', 'updates'].includes(tab) ? tab : 'launch');

  const close = () => {
    stopKbCapture();
    stopTgTtl();          // the pairing countdown must not outlive the panel
    onLayoutApplied = null;   // ручка не должна пережить панель
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const save = () => {
    const agents = [...agentListEl.querySelectorAll('.agent-cmd')]
      .map((i) => parseAgentLine(i.value))
      .filter((a) => a.cmd);
    launchList = agents.length ? agents : [{ cmd: 'claude', flags: '' }];
    saveLaunchList(); // also syncs `launch` + legacy keys to launchList[0]
    launchMode = overlay.querySelector('input[name="set-mode"]:checked')?.value || 'agent';
    saveLaunchMode();
    launchPick = overlay.querySelector('input[name="set-pick"]:checked')?.value || 'folder';
    saveLaunchPick();
    if (permI.value !== permMode) {
      permMode = permI.value;
      localStorage.setItem('swarm.permMode', permMode);
      window.swarm.setPermissionMode(permMode);  // main adds/drops --permission-mode
    }
    const nextRestartPct = RESTART_API.clampPct(restartPctI.value);
    if (restartI.checked !== restartOn || nextRestartPct !== restartPct) {
      restartOn = restartI.checked;
      restartPct = nextRestartPct;
      localStorage.setItem('swarm.restart', restartOn ? '1' : '0');
      localStorage.setItem('swarm.restartPct', String(restartPct));
      window.swarm.setRestart({ enabled: restartOn, threshold: restartPct });
    }
    pultEnabled = pultI.checked;
    localStorage.setItem('swarm.pult', pultEnabled ? '1' : '0');
    if (!pultEnabled) setPult(false); // no restart needed
    relayoutTabs();                   // adds or drops the Пульт tab
    notifyOnReady = readyI.checked;
    notifyOnWaiting = waitingI.checked;
    notifyActive = activeI.checked;
    notifySound = soundI.checked;
    localStorage.setItem('swarm.notifyReady', notifyOnReady ? '1' : '0');
    localStorage.setItem('swarm.notifyWaiting', notifyOnWaiting ? '1' : '0');
    localStorage.setItem('swarm.notifyActive', notifyActive ? '1' : '0');
    localStorage.setItem('swarm.notifySound', notifySound ? '1' : '0');
    applyNotify(onI.checked); // master switch (persists swarm.notify)
    appearance = { ...draft };
    saveAppearance();
    applyAppearance();
    tabstyle = TABSTYLE.normalizeTabStyle(tabDraft);
    saveTabStyle();
    applyTabStyle();
    // Раскладка последней: она перекладывает хром и подгоняет терминал под новый
    // размер сцены, а делать это стоит уже с применённым видом карточек.
    if (layoutDraft !== currentLayout()) applyLayout(layoutDraft);
    // Re-reflect the agent badge + «оранжевый пока работает сабагент» on live tabs:
    // main.js won't re-send an unchanged status, so a toggle flip must repaint here.
    // No notify — this is a settings change, not a real status transition.
    sessions.forEach((s) => { if (s.alive) { updateAgents(s); applyStatus(s, { notify: false }); } });
    keybinds = KEYBINDS_API.normalizeKeybinds(kbDraft, window.swarm.platform);
    saveKeybinds();
    close();
  };
  const onKey = (ev) => {
    if (kbCapturing) return; // capture handler owns Escape / keys
    // Открытая подсказка забирает первый Escape себе: иначе он закрывал бы всю панель, и
    // человек, заглянувший в объяснение, терял бы несохранённые правки.
    if (ev.key === 'Escape' && tipFor) { ev.preventDefault(); closeTip(); return; }
    if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); save(); }
  };
  overlay.querySelector('.modal-cancel').addEventListener('click', close);
  overlay.querySelector('.modal-ok').addEventListener('click', save);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  updGoBtn.addEventListener('click', () => {
    if (!updateState || updateState.kind === 'none') return;
    close();
    openUpdateModal();
  });
}

// opts.pult: called from the pult picking a chip — stay in pult mode. Without
// it (a click on an agent's own tab, ⌘1–⌘9) pult mode turns off.
function activate(id, opts) {
  const s = sessions.get(id);
  if (!s) return;
  // A link tooltip lives on document.body, not the terminal holder, so a
  // keyboard tab-switch with the mouse still over a link never fires the addon's
  // `leave` — drop any stale tip so it doesn't float over the new terminal.
  hideLinkTip();
  // A switch you asked for (tab click, ⌘1–9) needs no announcement, and kills a
  // handoff cue that may still be fading from the pult.
  if (!(opts && opts.pult)) clearHandoff();
  if (!(opts && opts.pult) && pultOn) setPult(false);
  // The diff overlay is a snapshot of the PREVIOUS active folder. Switching to a
  // different session — a tab click, ⌘1–⌘9, or the pult auto-advancing its queue
  // — would leave it showing the wrong folder's files. Drop it; the user reopens
  // it fresh for the new folder from the status-bar counter.
  if (activeId !== id) closeDiffOverlay();
  // Switching focus makes both the old and new terminals repaint — grace all
  // detectors so that burst isn't read as activity (would flash "работает").
  window.swarm.uiRepaint();
  for (const [, other] of sessions) {
    other.holder.classList.remove('active');
    other.tab.classList.remove('active');
  }
  s.holder.classList.add('active');
  // In pult mode the highlighted tab is the Пульт, not the agent you're reading.
  if (!pultOn) s.tab.classList.add('active');
  activeId = id;
  reportViewing();
  renderGate();
  // Refit now that the holder is visible (fit on a hidden element is a no-op).
  requestAnimationFrame(() => { s.fit.fit(); if (!renaming) s.term.focus(); });
  refreshGit();
}

// Куда человек смотрит: активная вкладка И фокус окна вместе. Та же пара, по которой гасятся
// уведомления («не звать про вкладку, в которую смотрят в упор») — но там она проверяется на
// месте, а здесь нужна В MAIN, где решают судьбу вкладки с непрочитанным ответом (unread.js).
//
// Шлём на КАЖДОЕ изменение любой из половин, а не по опросу: переключение вкладки и возврат к
// окну — это ровно те два действия, которыми человек говорит «я пришёл читать», и опрос раз в
// сколько-то секунд превратил бы их в «когда-нибудь заметим».
function reportViewing() {
  window.swarm.reportViewing(activeId, document.hasFocus());
}
window.addEventListener('focus', reportViewing);
window.addEventListener('blur', reportViewing);

function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  // The overlay shows THIS folder's diff. Once the tab is gone, refreshGit
  // repaints the bar for another tab while the overlay would keep showing the
  // old folder's files and querying difftext with a dead cwd.
  if (activeId === id) closeDiffOverlay();
  if (s.runTimer) { clearTimeout(s.runTimer); s.runTimer = null; }
  if (s.leaveWaitTimer) { clearTimeout(s.leaveWaitTimer); s.leaveWaitTimer = null; }
  hideLinkTip();
  window.swarm.killSession(id);
  s.term.dispose();
  s.holder.remove();
  s.tab.remove();
  sessions.delete(id);
  const key = s.cwd || '';
  const arr = withinOrder.get(key);
  if (arr) {
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1);
    if (!arr.length) {
      withinOrder.delete(key);
      const fi = folderOrder.indexOf(key);
      if (fi >= 0) folderOrder.splice(fi, 1);
    }
  }
  relayoutTabs();
  persistTabs();
  if (activeId === id) {
    const next = sessions.keys().next();
    if (!next.done) { activate(next.value); }
    else { activeId = null; renderGate(); }
  }
}

// Ask before closing — the × is easy to hit by accident.
async function requestCloseSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  const name = s.tab.querySelector('.label').textContent;
  if (await confirmModal(`Закрыть «${name}»? Сессия агента завершится.`, 'Закрыть')) closeSession(id);
}

// Save open tabs so they restore next launch. For Claude we also keep the conversation
// id (+ cmd/flags) to --resume that exact dialogue — not "last in cwd". sessionKey is
// the older, name-based handle: still written so a downgrade keeps working, and still
// read on restore for tabs saved before ids were kept.
function persistTabs() {
  const out = [];
  for (const u of orderedUnits()) {
    for (const s of u.list) {
      out.push({
        cwd: s.cwd || null,
        name: s.tab.querySelector('.label').textContent,
        cmd: s.cmd || null,
        flags: s.flags != null ? s.flags : null,
        blank: s.blank || false,
        sessionKey: s.sessionKey || null,
        claudeSessionId: s.claudeSessionId || null,
        tabKey: s.tabKey || null,
        // Мандат принадлежит вкладке, а не сеансу приложения: обновление сворма не должно
        // забирать у отданной вкладки разрешение работать.
        auto: !!s.auto,
      });
    }
  }
  localStorage.setItem('swarm.tabs', JSON.stringify(out));
}

// Sessions in display order, grouped into units (a folder or a loner) by cwd.
function orderedUnits() {
  const units = [];
  for (const cwd of folderOrder) {
    const list = (withinOrder.get(cwd) || []).filter((id) => sessions.has(id)).map((id) => sessions.get(id));
    if (list.length) units.push({ cwd, list });
  }

  return units;
}

// A default name for a new session: the folder basename, de-duplicated.
function defaultName(folderName) {
  const base = folderName || 'claude';
  const taken = new Set([...sessions.values()].map((s) => s.tab.querySelector('.label').textContent));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`)) i++;

  return `${base} ${i}`;
}

// Rebuild the sidebar, grouping sessions by working folder. A folder with one
// session shows the folder on the card; 2+ get boxed under a folder header.
// Existing tab elements are re-appended (listeners preserved).
// Everyone waiting on an answer, longest wait first. Tab/folder order is
// deliberately ignored: the queue is about who's been stuck longest.
function pultQueue() {
  return [...sessions.values()]
    .filter((s) => s.alive && s.status === 'waiting')
    .sort((a, b) => (a.waitingSince || 0) - (b.waitingSince || 0));
}

function fmtWait(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

// Repaint the strip + advance the queue. Safe to call any time: a no-op unless
// pult mode is on.
function renderPult() {
  const countEl = tabsEl.querySelector('.pult-count');
  const q = pultQueue();
  if (countEl) { countEl.textContent = q.length; countEl.hidden = q.length === 0; }
  if (!pultOn) return;

  document.body.classList.toggle('pult-empty', q.length === 0);
  // Hold the current pick while it's still waiting; otherwise take the head.
  // This is what makes the queue advance on its own once you've answered.
  const prevPick = pultPick;
  if (!q.some((s) => s.id === pultPick)) pultPick = q.length ? q[0].id : null;
  if (pultPick && pultPick !== activeId) {
    // Landing on a DIFFERENT agent without asking for it: the terminal under
    // your eyes is about to become someone else's. Announce who.
    const auto = !pultPickManual && pultPick !== prevPick;
    activate(pultPick, { pult: true });
    if (auto) flashHandoff(sessions.get(pultPick));
  }
  pultPickManual = false;

  const strip = document.getElementById('pult-strip');
  strip.innerHTML = '';
  const now = Date.now();
  for (const s of q) {
    const chip = document.createElement('div');
    chip.className = 'pult-chip' + (s.id === pultPick ? ' picked' : '')
      + (s.waitKind ? ' kind-' + s.waitKind : '');
    const name = s.tab.querySelector('.label').textContent;

    const dot = document.createElement('span');
    dot.className = 'dot';
    const nm = document.createElement('span');
    nm.className = 'pult-name';
    nm.textContent = name;
    chip.append(dot, nm);
    // WHY it's calling, when the detector/hooks are confident: разрешение / вопрос.
    if (s.waitKind) {
      const kd = document.createElement('span');
      kd.className = 'pult-kind';
      kd.textContent = KIND_LABEL[s.waitKind];
      chip.append(kd);
    }
    const tm = document.createElement('span');
    tm.className = 'pult-time';
    tm.textContent = fmtWait(now - (s.waitingSince || now));
    chip.append(tm);

    // The parsed question still makes a useful tooltip, but we don't print it on
    // the chip — the chip is just name + timer.
    if (s.question) chip.title = s.question;
    // The strip is rebuilt every second, so a chip mid-pulse is a NEW element:
    // resume its animation where the old one left off instead of restarting it.
    if (s.id === pultPick && pultFlashAt && now - pultFlashAt < PULT_FLASH_MS) {
      chip.classList.add('handoff');
      chip.style.animationDelay = -(now - pultFlashAt) + 'ms';
    }
    chip.addEventListener('click', () => {
      clearHandoff();
      pultPick = s.id;
      pultPickManual = true;
      renderPult();
    });
    strip.appendChild(chip);
  }
}

// The pult moved the terminal to another agent by itself. Say who, loudly enough
// to catch the eye but without stealing a beat: the terminal has already
// switched underneath. The plaque sits at the TOP of the stage so it never
// covers the prompt you're about to answer, and it's pointer-none — you can
// start typing into the new terminal while it's still fading.
function flashHandoff(s) {
  const el = document.getElementById('pult-flash');
  if (!el || !s) return;

  const head = document.createElement('div');
  head.className = 'pf-head';
  const arrow = document.createElement('span');
  arrow.className = 'pf-arrow';
  arrow.textContent = '→';
  const nm = document.createElement('span');
  nm.className = 'pf-name';
  nm.textContent = s.tab.querySelector('.label').textContent;
  head.append(arrow, nm);

  const sub = document.createElement('div');
  sub.className = 'pf-sub';
  if (s.waitKind) {
    const kd = document.createElement('span');
    kd.className = 'pf-kind';
    kd.textContent = KIND_LABEL[s.waitKind];
    sub.append(kd);
  }
  const tm = document.createElement('span');
  tm.textContent = 'ждёт ' + fmtWait(Date.now() - (s.waitingSince || Date.now()));
  sub.append(tm);

  el.className = s.waitKind ? 'kind-' + s.waitKind : '';
  el.replaceChildren(head, sub);

  // Clearing the queue fast means two handoffs inside PULT_FLASH_MS, and
  // re-adding a class in the same frame does NOT restart a CSS animation —
  // the offsetWidth read forces the reflow that does.
  document.body.classList.remove('pult-handoff', 'handoff-permission');
  void el.offsetWidth;
  document.body.classList.add('pult-handoff');
  if (s.waitKind === 'permission') document.body.classList.add('handoff-permission');

  pultFlashAt = Date.now();
  if (pultFlashTimer) clearTimeout(pultFlashTimer);
  pultFlashTimer = setTimeout(clearHandoff, PULT_FLASH_MS);
}

// Drop the cue early: any manual switch means you already know where you are.
function clearHandoff() {
  if (pultFlashTimer) { clearTimeout(pultFlashTimer); pultFlashTimer = null; }
  pultFlashAt = 0;
  document.body.classList.remove('pult-handoff', 'handoff-permission');
}

function refitActive() {
  const s = sessions.get(activeId);
  if (s) requestAnimationFrame(() => s.fit.fit());
}

function setPult(on) {
  const next = on && pultEnabled;
  pultOn = next;
  document.body.classList.toggle('pult-on', next);
  if (pultTimer) { clearInterval(pultTimer); pultTimer = null; }
  if (next) {
    pultTimer = setInterval(renderPult, 1000); // chips tick; only while open
    // Opening the pult is itself a gesture — the first agent it lands on is not
    // a handoff you need to be told about.
    pultPickManual = true;
    renderPult();
  } else {
    clearHandoff();
    document.body.classList.remove('pult-empty');
  }
  const t = tabsEl.querySelector('.pult-tab');
  if (t) t.classList.toggle('active', next);
  // Only one tab is ever lit. Entering the pult takes the highlight away from the
  // session you were reading (activate() only strips it when you SWITCH sessions,
  // so ⌘0 or a click on the pult would otherwise leave two tabs lit); leaving it
  // hands the highlight back to whatever session is on screen.
  for (const [id, s] of sessions) s.tab.classList.toggle('active', !next && id === activeId);
  // The strip changes .term-holder's inset, so the grid must be recomputed.
  refitActive();
}

function relayoutTabs() {
  for (const s of sessions.values()) s.sumDot = null; // reset; reassigned for collapsed groups
  tabsEl.innerHTML = '';
  // The stage is never :empty any more (the pult strip lives in it), so the
  // "no sessions" hint keys off this class instead.
  document.body.classList.toggle('no-sessions', sessions.size === 0);
  if (pultEnabled) {
    const pt = document.createElement('div');
    pt.className = 'pult-tab' + (pultOn ? ' active' : '');
    pt.title = `Пульт — кто ждёт ответа (${key('0')})`;
    pt.innerHTML = '<span class="pult-name">Пульт</span>'
      + '<span class="pult-count" hidden>0</span>';
    pt.addEventListener('click', () => setPult(true));
    tabsEl.appendChild(pt);
  }
  // Every working folder is a group (with a header) — even with a single tab.
  for (const { cwd, list } of orderedUnits()) {
    const folderName = cwd ? basename(cwd) : 'claude';
    const collapsed = collapsedFolders.has(cwd);
    const grp = document.createElement('div');
    grp.className = 'tab-group' + (collapsed ? ' collapsed' : '');
    grp.dataset.cwd = cwd;

    const head = document.createElement('div');
    head.className = 'group-head';
    head.title = collapsed ? 'Развернуть' : 'Свернуть';
    head.dataset.cwd = cwd;
    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.title = 'Перетащить папку';
    grip.innerHTML = ICONS.grip;
    attachDragHandle(head, grip, () => ({ kind: 'unit', cwd }));
    const chev = document.createElement('span');
    chev.className = 'group-chev';
    chev.innerHTML = ICONS.chevron;
    const nameEl = document.createElement('span');
    nameEl.className = 'group-name';
    setFolderLabel(nameEl, folderName);
    const count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = list.length;
    const dots = document.createElement('span');
    dots.className = 'group-dots'; // shown only when collapsed
    for (const s of list) {
      const d = document.createElement('span');
      d.className = 'sum-dot status-' + (s.status || 'ready');
      d.title = s.tab.querySelector('.label').textContent;
      d.addEventListener('click', (e) => { e.stopPropagation(); activate(s.id); });
      s.sumDot = d;
      dots.appendChild(d);
    }
    // Per-folder "+" — opens a new session in this folder, without collapsing it.
    const add = document.createElement('span');
    add.className = 'group-add';
    add.title = 'Новая сессия в этой папке';
    add.innerHTML = ICONS.plus;
    add.addEventListener('click', (e) => { e.stopPropagation(); createSessionFrom(add, cwd, true); });
    head.append(grip, chev, nameEl, count, dots, add);
    head.addEventListener('click', () => toggleFolder(cwd));

    const inner = document.createElement('div');
    inner.className = 'group-tabs';
    inner.addEventListener('dragover', (e) => onWithinDragOver(e, cwd));
    inner.addEventListener('drop', (e) => onWithinDrop(e, cwd));
    for (const s of list) {
      s.tab.dataset.cwd = cwd;
      inner.appendChild(s.tab);
    }
    grp.append(head, inner);
    tabsEl.appendChild(grp);
  }
  // "+" flows right after the last group, scrolling with the list. If it runs off
  // the edge with many tabs — fine, that beats a pinned button clipping the row.
  tabsEl.appendChild(newTabBtn);
  renderPult(); // the chip count lives on the freshly rebuilt Пульт tab
}

// --- drag & drop: live reflow (dragged item leaves a faint slot; others move) -
function axisOf() {
  return document.body.classList.contains('layout-top') ? 'x' : 'y';
}

// Что в ленте вкладок идёт ПОСЛЕ всех папок. Сейчас это кнопка «＋»: она не «в конце
// списка», она часть списка и всегда его хвост. Возвращаем её как точку вставки, чтобы
// «положить папку последней» значило «перед кнопкой», а не «после неё».
// null (кнопки в ленте почему-то нет) insertBefore понимает как обычный append.
function tailAnchor() {
  return newTabBtn.parentNode === tabsEl ? newTabBtn : null;
}

// The element the dragged item should be inserted before (null => append).
function dropBefore(els, x, y) {
  const axis = axisOf();
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const mid = axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2;
    if ((axis === 'x' ? x : y) < mid) return el;
  }

  return null;
}

// Cards and folder headers are dragged by their left grip only — dragging the
// whole card fought the click-to-activate and the double-click rename. HTML5 DnD
// can't tell us where the drag began, so the element is made draggable on
// mousedown over the grip and locked again as soon as the button is up.
function attachDragHandle(el, grip, payloadFor) {
  el.draggable = false;
  grip.addEventListener('mousedown', () => { el.draggable = true; });
  grip.addEventListener('click', (e) => e.stopPropagation()); // not an activate/collapse click
  el.addEventListener('dragstart', (e) => startDrag(e, payloadFor()));
}

// A plain click on the grip, or the end of a drag, re-locks whatever we unlocked.
// (During a real drag the browser eats mouseup, so this runs on `dragend` too.)
function lockDragHandles() {
  for (const el of document.querySelectorAll('.tab[draggable="true"], .group-head[draggable="true"]')) {
    el.draggable = false;
  }
}
document.addEventListener('mouseup', lockDragHandles);

function startDrag(e, payload) {
  drag = payload;
  dropped = false;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', payload.id || payload.cwd); } catch (_) {}
  // The in-list element becomes a dashed empty slot; a card, or the whole group
  // for a folder drag. Deferred so the browser's drag image (what follows the
  // cursor) is captured with full content first — then it turns into the slot.
  const ghost = payload.kind === 'unit' ? e.currentTarget.closest('.tab-group') : e.currentTarget;
  const el = ghost || e.currentTarget;
  setTimeout(() => { if (drag) el.classList.add('dragging'); }, 0);
}

function endDrag() {
  lockDragHandles();
  document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  if (!dropped) relayoutTabs(); // drop didn't land — restore original order
  dropped = false;
  drag = null;
}

// Reorder cards within one folder group by live-reflow.
function onWithinDragOver(e, cwd) {
  if (!drag || drag.kind !== 'card' || drag.cwd !== cwd) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
  const container = e.currentTarget;
  const draggedEl = sessions.get(drag.id)?.tab;
  if (!draggedEl) return;
  const others = [...container.querySelectorAll('.tab')].filter((el) => el !== draggedEl);
  const before = dropBefore(others, e.clientX, e.clientY);
  if (before) container.insertBefore(draggedEl, before);
  else container.appendChild(draggedEl);
}

function onWithinDrop(e, cwd) {
  if (!drag || drag.kind !== 'card' || drag.cwd !== cwd) return;
  e.preventDefault();
  e.stopPropagation();
  // DOM is already in the target order — sync it into the data model.
  withinOrder.set(cwd, [...e.currentTarget.querySelectorAll('.tab')].map((el) => el.dataset.sid));
  dropped = true;
  persistTabs();
}

// Collapse / expand a folder group (persisted).
function toggleFolder(cwd) {
  if (collapsedFolders.has(cwd)) collapsedFolders.delete(cwd);
  else collapsedFolders.add(cwd);
  localStorage.setItem('swarm.collapsed', JSON.stringify([...collapsedFolders]));
  relayoutTabs();
}

// Double-click a card title to rename it (e.g. what that agent is working on).
// Enter/Escape or blur commits; empty reverts to the default "claude <n>".
function attachRename(labelEl) {
  labelEl.title = 'Двойной клик — переименовать';
  labelEl.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    renaming = true;
    labelEl.contentEditable = 'plaintext-only';
    labelEl.spellcheck = false;
    labelEl.focus();
    const range = document.createRange();
    range.selectNodeContents(labelEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  labelEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); labelEl.blur(); }
    e.stopPropagation(); // don't fire app shortcuts (⌘T etc.) while typing
  });
  labelEl.addEventListener('blur', () => {
    renaming = false;
    labelEl.contentEditable = 'false';
    const text = labelEl.textContent.replace(/\s+/g, ' ').trim();
    labelEl.textContent = text || 'claude';
    persistTabs();
    // The Telegram bridge titles a topic after the tab, so a rename has to travel.
    const t = labelEl.closest('.tab');
    if (t && t.dataset.sid) window.swarm.setTabName(t.dataset.sid, labelEl.textContent);
  });
}

// --- layout switching (rail <-> top dashboard) -------------------------------
const LAYOUTS = ['layout-rail', 'layout-top'];
// Human labels for the layout picker in Settings → Вкладки (order = dropdown order).
const LAYOUT_LABELS = [
  { id: 'layout-rail', name: 'Список слева' },
  { id: 'layout-top', name: 'Карточки сверху' },
];

function currentLayout() {
  return document.body.classList.contains('layout-top') ? 'layout-top' : 'layout-rail';
}

// Пока модалка настроек открыта, она кладёт сюда свою ручку. Нужна ровно для ⌘L:
// раскладку можно переключить с клавиатуры, не закрывая настройки, и тогда селект в
// модалке обязан поехать за ней. Иначе «Сохранить» вернуло бы раскладку к той, что была
// при открытии, — нажатие ⌘L выглядело бы отменённым задним числом.
let onLayoutApplied = null;

function applyLayout(name) {
  if (!LAYOUTS.includes(name)) name = 'layout-rail';
  document.body.classList.remove(...LAYOUTS);
  document.body.classList.add(name);
  localStorage.setItem('swarm.layout', name);
  if (onLayoutApplied) onLayoutApplied(name);
  window.swarm.uiRepaint(); // the relayout repaints terminals — don't count it as activity
  // Chrome changed size => the stage did too; refit the visible terminal.
  requestAnimationFrame(() => {
    const s = sessions.get(activeId);
    if (s) s.fit.fit();
  });
}

function toggleLayout() {
  applyLayout(currentLayout() === 'layout-top' ? 'layout-rail' : 'layout-top');
}

// --- notifications -----------------------------------------------------------
// Ping when a BACKGROUND agent needs attention: it started waiting on me, or it
// finished (running -> ready). The agent you're actively watching in a focused
// window is never pinged — that would just be noise.
const MIN_RUN_MS = 3000; // a "run" shorter than this is a repaint blip, not real work
const NOTIFY_GRACE_MS = 10000; // stay silent for the first 10s after launch
const appStartedAt = Date.now(); // for the launch grace above

function maybeNotify(id, prev, next) {
  if (!notifyEnabled || prev === next) return;
  // Silent for the first NOTIFY_GRACE_MS after launch: restoring tabs respawns
  // claude in every folder, and those startup status flips aren't worth a ping.
  if (Date.now() - appStartedAt < NOTIFY_GRACE_MS) return;
  // By default you're already looking at THIS tab in a focused window — no need to
  // ping it. BACKGROUND tabs still ping even while the window is focused: that's the
  // whole point of a multi-agent pulpit — you can't watch every tab at once, so a
  // tab that finishes / starts waiting must announce itself. (An earlier version
  // muted ALL tabs whenever the window was focused, which silenced pings entirely
  // for anyone who keeps the pulpit open — the common case.) The notifyActive pref
  // opts back in to pinging the active/focused tab too.
  if (!notifyActive && id === activeId && document.hasFocus()) return;
  const s = sessions.get(id);

  let body = null;
  if (next === 'waiting') {
    if (!notifyOnWaiting) return;
    // WHY + WHAT: «разрешение»/«вопрос» (or generic «ждёт ответа»), then the parsed
    // question so you can often decide without switching tabs. Trimmed to ~140.
    const label = waitLabel(s);
    body = s && s.question ? `${label}: ${s.question}` : label;
    if (body.length > 140) body = body.slice(0, 139).trimEnd() + '…';
  } else if (next === 'ready' && prev === 'running') {
    if (!notifyOnReady) return;
    // Only ping "готов" if the agent actually worked for a bit — a sub-3s "run"
    // is almost always a false blip (a focus/repaint), not a finished task.
    if (s && s.runningSince && Date.now() - s.runningSince < MIN_RUN_MS) return;
    body = 'готов';
  }
  if (!body) return;

  const name = s?.tab.querySelector('.label')?.textContent?.trim() || `claude ${id}`;
  const note = new Notification(name, { body, silent: !notifySound });
  note.onclick = () => {
    window.swarm.focusApp();
    activate(id);
  };
}

function applyNotify(enabled) {
  notifyEnabled = enabled;
  localStorage.setItem('swarm.notify', enabled ? '1' : '0');
}

// --- quick commands ----------------------------------------------------------
// Send a slash command into the ACTIVE session, as if typed + Enter.
function runQuickCommand(text) {
  const s = sessions.get(activeId);
  if (!s || !s.alive) return;
  // Через ту же границу владения, что и клавиатура (typeInto): команда из меню — такая же
  // печать в строку ввода, и в отданной вкладке она столкнулась бы с толчком сворма ровно так
  // же. Мимо границы здесь был самый обидный обход: человек нажимает /clear в отданной вкладке
  // и получает мусор в строке, о котором его никто не предупреждал. Теперь команда из меню, как
  // и клавиша, просто не принимается, и об этом говорит плашка (blinkGate).
  typeInto(activeId, text + '\r');
  requestAnimationFrame(() => s.term.focus());
}

async function onQuickCommand(item) {
  closeCmdMenu();
  const s = sessions.get(activeId);
  if (!s || !s.alive) return;
  if (item.confirm && !(await confirmModal(item.confirm))) return;
  if (item.arg) {
    // Tee up "cmd " (no Enter) and hand focus back — you type the argument.
    typeInto(activeId, item.name + ' ');
    requestAnimationFrame(() => s.term.focus());

    return;
  }
  runQuickCommand(item.name);
}

function addCmdSection(title, menu = cmdMenu) {
  const sep = document.createElement('div');
  sep.className = 'cmd-sep';
  sep.textContent = title;
  menu.appendChild(sep);
}

function cmdItemButton(item) {
  const b = document.createElement('button');
  b.className = 'cmd-item' + (item.confirm ? ' danger' : '');
  b.innerHTML = '<span class="cmd-name"></span><span class="cmd-hint"></span>';
  // "…" on arg commands signals they tee up for you to finish typing.
  b.querySelector('.cmd-name').textContent = item.arg ? `${item.name} …` : item.name;
  b.querySelector('.cmd-hint').textContent = item.hint || '';
  b.addEventListener('click', () => onQuickCommand(item));

  return b;
}

async function openCmdMenu() {
  cmdMenu.innerHTML = '';
  const s = sessions.get(activeId);
  if (!s || !s.alive) {
    const empty = document.createElement('div');
    empty.className = 'cmd-empty';
    empty.textContent = 'нет активного агента';
    cmdMenu.appendChild(empty);
  } else {
    // Built-in commands grouped by purpose, then this project's custom commands.
    for (const g of BUILTIN_GROUPS) {
      addCmdSection(g.title);
      g.items.forEach((item) => cmdMenu.appendChild(cmdItemButton(item)));
    }
    let discovered = [];
    try { discovered = await window.swarm.listCommands(s.cwd); } catch (_) {}
    if (discovered.length) {
      addCmdSection('кастомные команды');
      discovered.forEach((item) => cmdMenu.appendChild(cmdItemButton(item)));
    }
  }
  cmdMenu.classList.remove('hidden');
  placeMenuUnder(cmdMenu, cmdBtn);
  setTimeout(() => document.addEventListener('mousedown', outsideCloseCmd), 0);
}

// Поставить всплывающий список под кнопкой: перевернуть вверх, если снизу не влезает,
// и прижать к краю окна. Меню должно быть уже показано (иначе нечего мерить), поэтому
// меряем его невидимым и открываем на месте — без этого он мигает в левом верхнем углу.
function placeMenuUnder(menu, anchor) {
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';
  const r = anchor.getBoundingClientRect();
  const mh = menu.offsetHeight;
  const mw = menu.offsetWidth;
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  const left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
  menu.style.top = top + 'px';
  menu.style.left = left + 'px';
  menu.style.visibility = 'visible';
}

function closeCmdMenu() {
  cmdMenu.classList.add('hidden');
  document.removeEventListener('mousedown', outsideCloseCmd);
}

function outsideCloseCmd(e) {
  if (!cmdMenu.contains(e.target) && !cmdBtn.contains(e.target)) closeCmdMenu();
}

function toggleCmdMenu() {
  if (cmdMenu.classList.contains('hidden')) openCmdMenu();
  else closeCmdMenu();
}

// --- diff overlay ------------------------------------------------------------
// Read-only by design: several agents write these files right now, so an editor
// here would be a write race (see the spec). "Открыть в редакторе" hands the
// file to the real IDE instead.
//
// A SNAPSHOT, not a live feed: re-rendering under the cursor while an agent
// writes would move the text you're reading. We freeze on open and offer an
// explicit "изменилось — обновить" instead.
let diffOverlay = null;

// Past this we stop building DOM. 50k changed lines = 50k nodes = a frozen
// overlay. The COUNTER stays honest either way — it comes from --numstat, not
// from what we drew.
const DIFF_MAX_LINES = 2000;

function diffTagFor(file) {
  if (file.status === 'added') return 'NEW';
  if (file.status === 'renamed') return 'RENAMED';
  if (file.status === 'binary') return 'BIN';
  if (file.big) return 'БОЛЬШОЙ';
  return '';
}

// Build the file tree into `host`. Returns the first file node, so the caller
// can open something instead of showing an empty pane.
function renderDiffTree(host, nodes, cwd, depth = 0) {
  let first = null;
  for (const n of nodes) {
    if (n.kind === 'dir') {
      const row = document.createElement('div');
      row.className = 'diff-node dir';
      row.style.paddingLeft = (10 + depth * 12) + 'px';
      row.textContent = n.name + '/';
      host.appendChild(row);
      const f = renderDiffTree(host, n.children, cwd, depth + 1);
      if (!first) first = f;
    } else {
      const btn = document.createElement('button');
      btn.className = 'diff-file';
      btn.style.paddingLeft = (10 + depth * 12) + 'px';
      btn.dataset.path = n.path;
      const { added, removed } = window.SWARM_DIFF.formatCount(n);
      const name = document.createElement('span');
      name.className = 'f-name';
      name.textContent = n.name; // text node, never markup — paths are hostile
      btn.appendChild(name);
      const tag = diffTagFor(n.file);
      if (tag) {
        const t = document.createElement('span');
        t.className = 'f-tag';
        t.textContent = tag;
        btn.appendChild(t);
      }
      if (added) { const a = document.createElement('span'); a.className = 'f-add'; a.textContent = added; btn.appendChild(a); }
      if (removed) { const d = document.createElement('span'); d.className = 'f-del'; d.textContent = removed; btn.appendChild(d); }
      const open = document.createElement('span');
      open.className = 'f-tag';
      open.textContent = '↗';
      open.title = 'Открыть в редакторе';
      open.addEventListener('click', (ev) => {
        ev.stopPropagation(); // don't also select the file
        window.swarm.openPath(cwd, n.path);
      });
      btn.appendChild(open);
      btn.addEventListener('click', () => selectDiffFile(cwd, n.path));
      host.appendChild(btn);
      if (!first) first = n;
    }
  }
  return first;
}

// Idempotent: called from Esc, the ✕, the backdrop, the stale pill — and from
// closeSession, where the overlay's folder may be going away entirely.
function closeDiffOverlay() {
  if (!diffOverlay) return;
  if (diffOverlay._onKey) document.removeEventListener('keydown', diffOverlay._onKey, true);
  diffOverlay.remove();
  diffOverlay = null;
}

function openDiffOverlay() {
  if (diffOverlay) return;                       // already open
  if (!gitDiff || !gitDiff.files.length) return; // nothing to show
  const cwd = sessions.get(activeId)?.cwd || '';
  const name = basename(cwd) || 'проект';
  const snapshot = gitDiff;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal diff">
      <div class="diff-head">
        <span class="diff-title"></span>
        <span class="diff-sum"><span class="d-add"></span><span class="d-del"></span></span>
        <button class="diff-stale" hidden>изменилось — обновить</button>
        <button class="diff-close" title="Закрыть (Esc)">✕</button>
      </div>
      <div class="diff-body">
        <div class="diff-tree"></div>
        <div class="diff-pane"></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  diffOverlay = overlay;
  overlay.dataset.sum = snapshot.added + '/' + snapshot.removed;

  overlay.querySelector('.diff-title').textContent = 'Изменения — ' + name;
  const sum = window.SWARM_DIFF.formatCount(snapshot);
  overlay.querySelector('.diff-sum .d-add').textContent = sum.added;
  overlay.querySelector('.diff-sum .d-del').textContent = sum.removed;

  const tree = overlay.querySelector('.diff-tree');
  const first = renderDiffTree(tree, window.SWARM_DIFF.buildTree(snapshot.files), cwd);

  const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); closeDiffOverlay(); } };
  overlay._onKey = onKey; // closeDiffOverlay needs it to unbind
  overlay.querySelector('.diff-close').addEventListener('click', closeDiffOverlay);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeDiffOverlay(); });
  overlay.querySelector('.diff-stale').addEventListener('click', () => {
    closeDiffOverlay();
    openDiffOverlay(); // reopen on the fresh gitDiff — an explicit, user-driven reload
  });
  document.addEventListener('keydown', onKey, true);

  if (first) selectDiffFile(cwd, first.path);
}

async function selectDiffFile(cwd, rel) {
  if (!diffOverlay) return;
  for (const b of diffOverlay.querySelectorAll('.diff-file')) {
    b.classList.toggle('active', b.dataset.path === rel);
  }
  const pane = diffOverlay.querySelector('.diff-pane');
  pane.textContent = '';

  const meta = (gitDiff?.files || []).find((f) => f.path === rel);
  if (meta?.binary) { pane.appendChild(diffNotice('Бинарный файл — показать нечего.', cwd, rel)); return; }
  if (meta?.big)    { pane.appendChild(diffNotice('Файл больше 2 МБ — не показываем.', cwd, rel)); return; }

  let text = '';
  try { text = await window.swarm.git.difftext(cwd, rel); } catch (_) {}
  if (!diffOverlay) return;                                    // closed during the await
  if (pane !== diffOverlay.querySelector('.diff-pane')) return; // reopened
  const hunks = window.SWARM_DIFF.parseUnified(text);
  if (!hunks.length) { pane.appendChild(diffNotice('Изменений нет.', cwd, rel)); return; }

  // The rows live in a max-content wide box, not straight in the scrolling pane:
  // otherwise every row is only as wide as the pane and the add/del background
  // gets cut off as soon as you scroll a long line sideways.
  const doc = document.createElement('div');
  doc.className = 'diff-doc';
  let drawn = 0;
  let total = 0;
  for (const h of hunks) total += h.lines.length;

  outer:
  for (const h of hunks) {
    const head = document.createElement('div');
    head.className = 'diff-hunk';
    const headText = document.createElement('span'); // pinned to the left edge on x-scroll
    headText.textContent = h.header;
    head.appendChild(headText);
    doc.appendChild(head);
    for (const l of h.lines) {
      if (drawn >= DIFF_MAX_LINES) break outer;
      const row = document.createElement('div');
      row.className = 'diff-line ' + l.type;
      const ln = document.createElement('span');
      ln.className = 'ln';
      ln.textContent = l.type === 'add' ? String(l.newNo ?? '') : String(l.oldNo ?? '');
      const tx = document.createElement('span');
      tx.className = 'tx';
      tx.textContent = l.type === 'meta' ? l.text : (l.text || ' '); // text node, never markup
      row.appendChild(ln);
      row.appendChild(tx);
      doc.appendChild(row);
      drawn++;
    }
  }
  pane.appendChild(doc);

  if (drawn < total) {
    pane.appendChild(diffNotice(
      `Показаны первые ${drawn} строк из ${total}.`, cwd, rel,
    ));
  }
}

// A muted line at the bottom of the pane + the escape hatch to a real editor.
function diffNotice(text, cwd, rel) {
  const box = document.createElement('div');
  box.className = 'diff-more';
  box.textContent = text;
  const btn = document.createElement('button');
  btn.className = 'diff-open';
  btn.textContent = 'Открыть в редакторе';
  btn.addEventListener('click', () => window.swarm.openPath(cwd, rel));
  box.appendChild(btn);
  return box;
}

// --- git branch menu ---------------------------------------------------------
function gitMenuButton(label, hint, onClick) {
  const b = document.createElement('button');
  b.className = 'cmd-item';
  b.innerHTML = '<span class="cmd-name"></span><span class="cmd-hint"></span>';
  b.querySelector('.cmd-name').textContent = label;
  b.querySelector('.cmd-hint').textContent = hint || '';
  b.addEventListener('click', onClick);
  return b;
}

async function openGitMenu() {
  if (!gitInfo || !gitInfo.isRepo) return; // nothing to show for a non-repo
  const cwd = sessions.get(activeId)?.cwd || '';
  gitMenu.innerHTML = '';

  addCmdSection(`ветка: ${gitInfo.branch}${gitInfo.behind ? ' ↓' + gitInfo.behind : ''}${gitInfo.ahead ? ' ↑' + gitInfo.ahead : ''}`, gitMenu);
  gitMenu.appendChild(gitMenuButton('Обновить', 'git fetch', onGitFetch));
  if (gitInfo.behind) gitMenu.appendChild(gitMenuButton(`Подтянуть (${gitInfo.behind})`, 'git pull --ff-only', onGitPull));

  addCmdSection('переключиться на', gitMenu);
  let branches = [];
  try { branches = await window.swarm.git.branches(cwd); } catch (_) {}
  const current = gitInfo.branch;
  if (!branches.length) {
    const empty = document.createElement('div');
    empty.className = 'cmd-empty';
    empty.textContent = 'нет локальных веток';
    gitMenu.appendChild(empty);
  } else {
    branches.forEach((b) => {
      const label = b === current ? `● ${b}` : b;
      gitMenu.appendChild(gitMenuButton(label, b === current ? 'текущая' : '', () => onGitCheckout(b)));
    });
  }

  // Anchor above the branch button (the bar sits at the bottom of the window).
  gitMenu.classList.remove('hidden');
  gitMenu.style.visibility = 'hidden';
  gitMenu.style.left = '0px';
  gitMenu.style.top = '0px';
  const r = gitBtn.getBoundingClientRect();
  const mh = gitMenu.offsetHeight;
  const mw = gitMenu.offsetWidth;
  let top = r.top - mh - 6;
  if (top < 8) top = Math.min(window.innerHeight - mh - 8, r.bottom + 6);
  const left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
  gitMenu.style.top = top + 'px';
  gitMenu.style.left = left + 'px';
  gitMenu.style.visibility = 'visible';
  setTimeout(() => document.addEventListener('mousedown', outsideCloseGit), 0);
}

function closeGitMenu() {
  gitMenu.classList.add('hidden');
  document.removeEventListener('mousedown', outsideCloseGit);
}

function outsideCloseGit(e) {
  if (!gitMenu.contains(e.target) && !gitBtn.contains(e.target)) closeGitMenu();
}

function toggleGitMenu() {
  if (gitMenu.classList.contains('hidden')) openGitMenu();
  else closeGitMenu();
}

async function onGitCheckout(branch) {
  closeGitMenu();
  const cwd = sessions.get(activeId)?.cwd;
  if (!cwd) return;
  const res = await window.swarm.git.checkout(cwd, branch);
  if (!res.ok) showGitMsg(res.error || 'не удалось переключиться');
  else clearGitMsg();
  refreshGit();
}

async function onGitFetch() {
  closeGitMenu();
  const cwd = sessions.get(activeId)?.cwd;
  if (!cwd) return;
  showGitMsg('обновляю…', 0);
  const res = await window.swarm.git.fetch(cwd);
  if (res.ok) clearGitMsg();
  else if (isGitAuthError(res.error)) { clearGitMsg(); showGitLoginModal(); }
  else showGitMsg(res.error || 'не удалось обновить');
  refreshGit();
}

async function onGitPull() {
  closeGitMenu();
  const cwd = sessions.get(activeId)?.cwd;
  if (!cwd) return;
  showGitMsg('подтягиваю…', 0);
  const res = await window.swarm.git.pull(cwd);
  if (res.ok) clearGitMsg();
  else if (isGitAuthError(res.error)) { clearGitMsg(); showGitLoginModal(); }
  else showGitMsg(res.error || 'не удалось подтянуть');
  refreshGit();
}

// Dark themed confirm dialog. Resolves true/false.
// --- граница владения ---------------------------------------------------------------------
// Вкладка, которую человек отдал, ему не принадлежит: печатать в неё нельзя, пока он её не
// забрал. Это не запрет ради запрета. Во-первых, в такую вкладку печатает САМ СВОРМ (толчок
// правилом, вопрос про фазу, будильник по лимиту), и два писателя в одну строку ввода дают
// мусор вместо просьбы — этой ценой мы уже платили за перезапуск. Во-вторых, человек, который
// печатает в отданную вкладку, обычно просто забыл, что отдал её, — и половина разговора
// уезжает агенту, который в это время решает сам.
//
// Печать в отданную вкладку не копится и не досылается — она просто не принимается: хочешь
// печатать, забери вкладку. Копить пробовали, и вышло дороже пользы. Первая клавиша поднимала
// модальный вопрос «забрать себе?» — а поднимался он на КАЖДОЕ движение мыши (доклады мыши
// приходили тем же путём, что печать, см. termtalk.js) и держал весь сворм, пока его не
// закроешь: отданную вкладку нельзя было даже открыть почитать. Теперь про владение говорит
// плашка над терминалом — заметная, но ничего не отнимающая (см. renderGate).
const gateEl = document.getElementById('gate-strip');
if (gateEl) {
  gateEl.querySelector('.gate-moon').innerHTML = ICONS.moon;
  gateEl.querySelector('.gate-take').addEventListener('click', () => takeGate(activeId));
}
let gateBlocked = false;          // только что попробовали напечатать — плашка отвечает на это
let gateBlockedTimer = null;

// Работает ли вкладка без человека ПРЯМО СЕЙЧАС: своя отметка или общий ночной режим.
function autoNow(id) {
  const s = sessions.get(id);
  if (!s) return false;
  // Одно исключение, и оно про главный случай, когда человек нужен отданной вкладке: запрос
  // разрешения. Сворм в такую вкладку не печатает НИКОГДА (одобрять чужие команды молча — не то,
  // за что стоит платить спокойным сном), значит двух писателей тут быть не может, а нажать «1»
  // в диалоге — ровно то, зачем человек к ней и подошёл. Гейт здесь отнимал бы у вкладки мандат
  // за одно нажатие.
  if (s.status === 'waiting' && s.waitKind === 'permission') return false;
  return !!(nightNow.on || s.auto);
}

// Отдана ли вкладка ВООБЩЕ — без исключения про разрешение. Плашка говорит про владение, а не
// про судьбу конкретного нажатия: она меняет высоту терминала, и мигать ею на каждом вопросе
// агента значило бы пересчитывать сетку по десять раз за час.
function gatedTab(id) {
  const s = sessions.get(id);
  return !!(s && (nightNow.on || s.auto));
}

function typeInto(id, bytes) {
  if (!bytes) return;
  const s = sessions.get(id);
  if (!autoNow(id)) {
    if (s && s.scanTyped) s.scanTyped(bytes);
    window.swarm.sendInput(id, bytes);
    return;
  }
  // Нажатие не уходит никуда и нигде не ждёт. Молчать об этом нельзя — иначе человек печатает
  // в пустоту и считает приложение сломанным, — поэтому отвечает плашка.
  blinkGate(id);
}

// Плашка владения. Одна на сцену: печатают всегда в активную вкладку, про неё и речь.
function renderGate() {
  if (!gateEl) return;
  const s = sessions.get(activeId);
  const on = !!s && gatedTab(activeId);
  for (const [id, sess] of sessions) sess.holder.classList.toggle('gated', on && id === activeId);
  const was = !gateEl.hidden;
  gateEl.hidden = !on;
  if (!on) {
    gateEl.classList.remove('is-blocked');
    if (was) refitActive();       // плашка ушла — терминалу вернулась её высота
    return;
  }
  const name = s.tab.querySelector('.label').textContent;
  // Кнопка одна, и это тоже часть починки. Раньше их было две — «Забрать себе» и «Я за
  // клавиатурой», — потому что общее положение лежало отдельным слоем поверх вкладок: снять
  // отметку карточки было мало. Теперь общее положение считается ПО вкладкам, и «забрать эту»
  // — единственное, что здесь можно сделать; остальные вкладки продолжают сами.
  const away = !!nightNow.on;
  const asks = s.status === 'waiting' && s.waitKind === 'permission';
  gateEl.querySelector('.gate-text').textContent = gateBlocked
    ? `Нажатие не ушло: «${name}» работает без вас. Чтобы печатать, заберите вкладку.`
    : asks
      ? `«${name}» работает без вас, но сейчас спрашивает разрешение — ответить можно, не забирая.`
      : away
        ? `Сейчас без вас работают все вкладки, «${name}» в их числе: печать ей не уходит.`
        : `«${name}» работает без вас — печать ей не уходит.`;
  const btn = gateEl.querySelector('.gate-take');
  btn.textContent = 'Забрать себе';
  btn.title = away
    ? 'Забрать эту вкладку: она снова ваша, печать уходит агенту. Остальные продолжают сами —'
      + ' а общий режим снимется, потому что отданы уже не все.'
    : 'Снять с вкладки ночной режим: она снова ваша, печать уходит агенту.';
  if (!was) refitActive();        // плашка появилась — терминал уезжает вниз
}

// Попытка напечатать в чужую вкладку. Нажатие пропало, и плашка должна это ПОКАЗАТЬ: молчание
// здесь неотличимо от сломанной клавиатуры.
function blinkGate(id) {
  if (!gateEl || id !== activeId) return;
  gateBlocked = true;
  if (gateBlockedTimer) clearTimeout(gateBlockedTimer);
  gateBlockedTimer = setTimeout(() => {
    gateBlockedTimer = null;
    gateBlocked = false;
    gateEl.classList.remove('is-blocked');
    renderGate();
  }, 2600);
  gateEl.classList.remove('is-blocked');
  void gateEl.offsetWidth;        // перезапуск анимации, если жали второй раз подряд
  gateEl.classList.add('is-blocked');
  renderGate();
}

// Забрать значит забрать: если в силе общее положение — снимаем и его, иначе кнопка обманет.
// Отметку вкладки снимает main и присылает пушем tab:auto — той же дорогой, что из меню
// карточки и из чата (см. applyTabAuto), и плашка гаснет уже оттуда.
async function takeGate(id) {
  const s = sessions.get(id);
  if (!s) return;
  // Забираем ОДНУ эту вкладку — и всё. Общее положение снимется само: оно считается по
  // вкладкам, и та, которую только что забрали, больше не даёт сумме сойтись. Раньше здесь
  // стояло ещё и выключение общего режима, и кнопка на одной карточке возвращала человеку
  // сразу все вкладки — соседние вкладки теряли мандат молча.
  if (s.auto) { try { await window.swarm.night.setTab(id, false); } catch (_) {} }
  renderGate();
  s.term.focus();                 // кнопка забрала фокус у терминала — возвращаем сразу
}

// Мандат вкладки поменялся (меню карточки, чат, гейт) — обновляем отметку и запоминаем.
//
// Подсказка висит на САМОЙ КАРТОЧКЕ, а не на отдельном значке: у скрытого элемента подсказки не
// бывает вовсе (display:none — нет и всплывающей строки), а объяснение нужно ровно там, где
// человек видит кромку и не понимает, почему в вкладку не печатается.
function applyTabAuto(id, on) {
  const s = sessions.get(String(id));
  if (!s) return;
  s.auto = !!on;
  paintAuto(s);
  persistTabs();
  renderGate();
}

// Вид отданной вкладки. Красится она ЦЕЛИКОМ — цвет отвечает «чья она», а не «что с агентом»,
// — и из-за этого у ночного режима был слепой угол: четыре отданные вкладки выглядят одинаково
// и когда все четыре работают, и когда три уже сдали работу. Между ходами агент молчит, и
// молчание не отличить от конца задачи.
//
// Отличает их слово самого агента (тег конца задачи, см. DONE_TAGS в ask-phrases.js): пришло
// оно — карточка зеленеет, оставаясь отданной (полумесяц на месте, печать в неё по-прежнему не
// уходит). Заработала снова — снова ночная.
function paintAuto(s) {
  if (!s || !s.tab) return;
  const on = !!s.auto;
  const done = on && !!s.done;
  s.tab.classList.toggle('is-auto', on);
  s.tab.classList.toggle('is-done', done);
  s.tab.title = !on ? ''
    : done
      ? 'Ночной режим, работа сдана: агент сказал, что задача кончилась, — откройте вкладку и'
        + ' прочитайте итог. Вкладка всё ещё отдана: печать в неё не уходит, забрать её —'
        + ' полумесяц или кнопка в плашке над терминалом.'
      : 'Ночной режим: агент решает сам, сворм подталкивает вкладку и будит. Печать в неё'
        + ' не уходит — полумесяц или кнопка в плашке над терминалом, чтобы забрать себе.';
  const moon = s.tab.querySelector('.moon');
  if (moon) {
    moon.title = !on ? 'Ночной режим: пусть работает без вас'
      : done ? 'Забрать себе: работа сдана' : 'Забрать себе: сейчас работает без вас';
    moon.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

// Клик по полумесяцу. Решение принимает main (он же владеет общим положением и журналом),
// сюда мандат вернётся пушем tab:auto — той же дорогой, что из меню карточки и из чата.
async function toggleTabAuto(id) {
  const s = sessions.get(String(id));
  if (!s) return;
  try { await window.swarm.night.setTab(String(id), !s.auto); } catch (_) { /* main ответит пушем */ }
}

window.swarm.night.onTab(({ id, auto }) => applyTabAuto(id, auto));

function confirmModal(message, okLabel = 'Выполнить') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-msg"></div>
        <div class="modal-actions">
          <button class="modal-cancel">Отмена</button>
          <button class="modal-ok"></button>
        </div>
      </div>`;
    overlay.querySelector('.modal-msg').textContent = message;
    overlay.querySelector('.modal-ok').textContent = okLabel;
    document.body.appendChild(overlay);

    const close = (val) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(val);
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); close(false); }
      else if (ev.key === 'Enter') { ev.preventDefault(); close(true); }
    };
    overlay.querySelector('.modal-cancel').addEventListener('click', () => close(false));
    overlay.querySelector('.modal-ok').addEventListener('click', () => close(true));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', onKey, true);
    overlay.querySelector('.modal-ok').focus();
  });
}

// Built-in help. Static, author-trusted HTML (no user input) — focuses on the
// gotchas: what a tab really is, what the statuses mean, and — the big one — that
// the app runs whatever `claude` your environment resolves to, so account/model
// selection lives in your shell, not here.
const HELP_HTML = `
  <h3>Swarm</h3>
  <p>Пульт для нескольких сессий Claude Code разом. Каждая вкладка — <b>настоящий процесс <code>claude</code></b> в вашем login-шелле; приложение его только показывает и переключает. Токенов оно не хранит.</p>

  <h4>Статусы вкладок</h4>
  <ul>
    <li><b>оранжевая — работает</b>: печатает, думает, гоняет инструмент.</li>
    <li><b>бирюзовая — ждёт ответа</b>: на экране вопрос или запрос разрешения, нужен ваш ввод.</li>
    <li><b>зелёная — закончил</b>: ход кончился, вкладка свободна.</li>
    <li><b>серая — закрыта</b>: процесса больше нет.</li>
  </ul>

  <h4>Git-ветка (панель снизу)</h4>
  <p>Внизу окна видно, на какой <b>ветке</b> git находится папка активной вкладки. Значки рядом: <code>+N&nbsp;−M</code> — сколько строк добавлено и удалено, но не закоммичено; <code>↓N</code> — на сервере N новых коммитов, которые можно забрать; <code>↑N</code> — у вас N своих, ещё не отправленных.</p>
  <ul>
    <li><b>Клик по ветке</b> — меню: <b>Обновить</b> (свериться с сервером), <b>Подтянуть</b> (забрать новое — появляется, когда есть <code>↓</code>), и список веток. Клик по ветке — переключиться на неё. Ветки идут по свежести: недавние сверху.</li>
    <li>Просмотр и переключение веток работают <b>всегда</b>, даже без входа в git — это локально.</li>
    <li><b>Обновить / Подтянуть</b> ходят на сервер и требуют <b>входа в git</b>. Если вы не залогинены, выскочит окно с объяснением, как войти (это делается один раз в терминале вкладки).</li>
    <li>Если папка вкладки — не git-репозиторий, панель ветки пустая.</li>
  </ul>

  <h4>После перезапуска</h4>
  <p>Вкладки (папка + имя) запоминаются всегда, и диалоги возвращаются сами — отдельной галочки для этого нет. Работает это там, где есть чему возвращаться: у Claude Code.</p>

  <h4>Горячие клавиши</h4>
  <ul>
    <li><code>${key('T')}</code> — новая вкладка (папка по умолчанию) · <code>${key('O')}</code> — с выбором папки</li>
    <li><code>${key('K')}</code> — палитра команд · <code>${key('L')}</code> — раскладка · <code>${key('W')}</code> — закрыть вкладку</li>
    <li><code>${key('1')}…9</code> — прыжок на вкладку · <code>${key('/')}</code> — эта справка</li>
  </ul>

  <h4>Какой аккаунт / модель запускается</h4>
  <p>Приложение наследует окружение от того, <b>кто его запустил</b>, и просто печатает <code>claude</code>. Значит выбор аккаунта живёт в вашем шелле, а не в приложении:</p>
  <ul>
    <li><b>Надёжно:</b> ${HOST.exports}. Каждая вкладка поднимает login-шелл, читает ${HOST.profile} и подхватывает их — даже при запуске из ${HOST.fileManager}.</li>
    <li>Запуск из ${HOST.fileManager} без этих настроек = голое окружение → дефолтный <code>claude</code> (может быть разлогинен).</li>
    <li>Правки подхватывают <b>новые</b> вкладки; уже открытые — нет.</li>
  </ul>

  <h4>Другие модели (GLM, DeepSeek…)</h4>
  <p>Если модель подключена через <code>ANTHROPIC_BASE_URL</code> — это <b>тот же Claude Code</b>, просто другой бэкенд. Всё работает без изменений: команды (<code>/compact</code>, <code>/clear</code>, <code>/usage</code>) — это фичи CLI, а не модели. Токен и base URL держите в ${HOST.profile}, <b>не в приложении</b>.</p>

  <h4>Запоминание команды запуска</h4>
  <p>Наберите в терминале вкладки нужный лончер <b>руками</b> (<code>claude-my</code>, <code>claude-glm</code>, <code>glm</code>…) — приложение привяжет его к <b>этой</b> вкладке (при перезапуске снова откроет им) и сделает командой по умолчанию для новых. Ловится только набранное или вставленное: команда из истории стрелкой ↑ не считается, наберите её разок целиком.</p>
`;

function openHelp() {
  if (document.querySelector('.modal-overlay .modal.help')) return; // already open
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal help">
      <div class="help-body">${HELP_HTML}</div>
      <div class="modal-actions"><button class="modal-ok help-close">Понятно</button></div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  overlay.querySelector('.help-close').addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  overlay.querySelector('.help-close').focus();
}

// Opened from the native "Справка" app-menu item (⌘/), handled in main.
window.swarm.onOpenHelp(openHelp);

// ⌘C (native Edit → Copy) routes here instead of the stock `copy` role, whose
// native path mangled the xterm selection's encoding (Cyrillic → MacRoman
// mojibake). We read the selection as a proper JS string and write it via
// Electron's clipboard (correct UTF-8): the active terminal's selection if it has
// one, otherwise the page's DOM selection (a modal, the branch bar, etc.).
window.swarm.onMenuCopy(() => {
  const s = sessions.get(activeId);
  if (s && s.term && s.term.hasSelection()) {
    window.swarm.clipboardWrite(s.term.getSelection());
    return;
  }
  // Form fields: window.getSelection() is empty inside <input>/<textarea>, so read
  // the field's own selection range (e.g. the launch cmd/flags in Settings).
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') &&
      el.selectionStart != null && el.selectionStart !== el.selectionEnd) {
    window.swarm.clipboardWrite(el.value.substring(el.selectionStart, el.selectionEnd));
    return;
  }
  const domSel = window.getSelection ? String(window.getSelection()) : '';
  if (domSel) window.swarm.clipboardWrite(domSel);
});

// Refit the active terminal when the window changes size.
window.addEventListener('resize', () => {
  const s = sessions.get(activeId);
  if (s) s.fit.fit();
});

// Refit when the terminal area itself resizes — e.g. the top chrome bar grows or
// shrinks as cards gain context meters, wrap long names, or groups collapse.
// Without this the terminal overflows its container and clips the last line.
const stageObserver = new ResizeObserver(() => {
  const s = sessions.get(activeId);
  if (s) s.fit.fit();
});
stageObserver.observe(stageEl);

// Top-level reorder: dragging a loner card or a group head reorders the units
// (folders + loners). A unit never drops inside a folder (that handler ignores it).
tabsEl.addEventListener('dragover', (e) => {
  if (!drag || drag.kind !== 'unit') return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const dragged = [...tabsEl.children].find((el) => el.dataset.cwd === drag.cwd);
  if (!dragged) return;
  const others = [...tabsEl.children].filter((el) => el.dataset.cwd && el !== dragged);
  const before = dropBefore(others, e.clientX, e.clientY);
  // Кнопка «＋» живёт в этой же ленте последним ребёнком (см. relayoutTabs), поэтому
  // «за последнюю папку» — это НЕ конец ленты, а место перед кнопкой. Пока здесь стоял
  // appendChild, папка уезжала за кнопку, и, перетащив так все папки по очереди, человек
  // получал «＋» слева от всего списка — там, где он ничего не открывает, а мешает.
  tabsEl.insertBefore(dragged, before || tailAnchor());
});
tabsEl.addEventListener('drop', (e) => {
  if (!drag || drag.kind !== 'unit') return;
  e.preventDefault();
  folderOrder.length = 0;
  folderOrder.push(...[...tabsEl.children].filter((el) => el.dataset.cwd).map((el) => el.dataset.cwd));
  dropped = true;
  persistTabs();
});
document.addEventListener('dragend', endDrag);

// Swallow the browser default for any drag/drop that isn't over the tab strip
// (those handlers do their own preventDefault + reordering). Without this, a file
// dropped onto the terminal/stage makes Chromium navigate the page to that file
// and render its raw source — the window would then show e.g. preload.js, not the
// UI. main.js also blocks will-navigate as a backstop.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// Shortcuts: ⌘T new, ⌘W close, ⌘L toggle layout, ⌘1..9 jump.
window.addEventListener('keydown', (e) => {
  // Don't steal keys while typing in a form field or capturing a chord in Settings.
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
  if (document.querySelector('.kb-capturing')) return;

  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === 't') { e.preventDefault(); createSession(); }
  else if (e.key === 'o') { e.preventDefault(); createSessionInFolder(); }
  else if (e.key === 'k') { e.preventDefault(); toggleCmdMenu(); }
  else if (e.key === ',') { e.preventDefault(); showSettingsModal(); }
  // Always preventDefault: in pult mode activeId is an agent you're merely
  // reading, so ⌘W must not close it — but it must not reach Electron and close
  // the window either.
  else if (e.key === 'w') { e.preventDefault(); if (activeId && !pultOn) requestCloseSession(activeId); }
  else if (e.key === 'l') { e.preventDefault(); toggleLayout(); }
  else if (e.key === '0') { e.preventDefault(); if (pultEnabled) setPult(true); }
  else if (/^[1-9]$/.test(e.key)) {
    // Unchanged: the pult took ⌘0, so agent digits never shift.
    const idx = Number(e.key) - 1;
    const id = [...sessions.keys()][idx];
    if (id) { e.preventDefault(); activate(id); }
  }
});

// --- auto-update -------------------------------------------------------------
// A pill in the status bar appears when the manifest advertises a newer version.
// Clicking it opens a modal: asar-swap (small, in-app) or a full-installer fallback
// when the runtime changed. Checks on launch + every 4h + manually from Settings.
let updateState = null; // last decideUpdate result with kind 'asar'|'installer'
// Версия, скачанная В ЭТОМ запуске: страховка от повторной загрузки, если перезапуск
// после успешной кнопки почему-то не случился и окно открыли снова. Между запусками не
// живёт — плашка про неё ничего не знает и знать не должна.
let updateArmed = '';
let arming = null;      // {version, promise} — тихая загрузка в полёте
const UPDATE_POLL_MS = 4 * 60 * 60 * 1000;

function snoozedVersion() { return localStorage.getItem('swarm.update.snooze') || ''; }

function renderUpdatePill() {
  const pill = document.getElementById('update-pill');
  if (!pill) return;
  // У плашки ОДНО состояние: доступна новая версия. Момент обновления выбирает человек, и
  // до его нажатия ничего не скачано и ничего не ждёт — писать «при перезапуске» было бы
  // не о чем. Заведомо тихая докачка отсюда убрана намеренно, см. checkForUpdate.
  const show = updateState && updateState.kind !== 'none' && updateState.version !== snoozedVersion();
  pill.hidden = !show;
  if (show) pill.textContent = '↑ Обновить ' + updateState.version;
}

// Скачать обновление и положить его рядом. Зовётся ТОЛЬКО по кнопке — сама по себе
// программа этого не делает.
//
// applyPayload не трогает установленное приложение: он кладёт новый asar в папку настроек и
// переставляет указатель, а поднимает его загрузчик при следующем запуске. Перезапуск —
// отдельный IPC, и раньше кнопка просто звала оба подряд. Из-за этой склейки обновление
// стоило всех живых вкладок разом, то есть его не ставили вовсе.
//
// Одна загрузка на версию, кто бы её ни попросил — фон или кнопка: два applyPayload писали
// бы в один и тот же <версия>.asar.part и оба получили бы мусор.
function armUpdate(st) {
  if (!st || st.kind !== 'asar' || !st.asar) return Promise.resolve({ ok: false });
  if (updateArmed === st.version) return Promise.resolve({ ok: true });
  if (arming && arming.version === st.version) return arming.promise;
  const promise = window.swarm.updateApply(st.asar.url, st.asar.sha256, st.version)
    .then((res) => {
      if (res && res.ok) updateArmed = st.version;
      return res;
    })
    // Не вышло (нет связи, не сошлась sha) — молчим. Плашка остаётся прежней «↑ Обновить»,
    // и человек попадает в старое окно с кнопкой: фоновая попытка не должна ни ругаться,
    // ни отнимать ручной путь.
    .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
    .finally(() => { if (arming && arming.version === st.version) arming = null; });
  arming = { version: st.version, promise };
  return promise;
}

async function checkForUpdate(manual) {
  let res = null;
  try { res = await window.swarm.updateCheck(); } catch (_) { res = { kind: 'offline' }; }
  // Связи не было — мы ничего не узнали. Ни плашку не трогаем (обновление, про которое
  // уже знали, никуда не делось), ни отметку о проверке (иначе следующая попытка
  // отложится на весь период опроса). Молчим, если проверку никто не просил.
  if (res && res.kind === 'offline') {
    if (manual) confirmModalInfo('Не удалось проверить обновления — нет связи. Попробую ещё раз позже.');
    return res;
  }
  localStorage.setItem('swarm.update.lastCheck', String(Date.now()));
  if (res && res.kind !== 'none') {
    const prev = updateState && updateState.kind !== 'none' ? updateState.version : '';
    updateState = res;
    renderUpdatePill();
    // Нашли — ТОЛЬКО показываем. Скачивание начинается по кнопке и ничем иным: момент
    // обновления выбирает человек, а не приложение за него.
    if (manual) openUpdateModal();
    else if (prev && prev !== res.version) {
      // A newer release appeared after we already had a pill for an older one.
      confirmModalInfo('Доступна более новая версия ' + res.version + ' (раньше предлагалась ' + prev + ').');
    }
  } else if (manual) {
    updateState = res;
    renderUpdatePill();
    alertNoUpdate();
  } else if (res && res.kind === 'none') {
    updateState = res;
    renderUpdatePill();
  }
  return res;
}

function alertNoUpdate() {
  confirmModalInfo('Обновлений нет — установлена последняя версия.');
}

// A one-button info modal (reuses the confirm modal look).
function confirmModalInfo(message) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal"><div class="modal-msg"></div>
    <div class="modal-actions"><button class="modal-ok neutral">Понятно</button></div></div>`;
  overlay.querySelector('.modal-msg').textContent = message;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.modal-ok').addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
}

async function openUpdateModal() {
  if (document.querySelector('.modal-overlay .modal.update')) return;
  // Always re-fetch so the pill/modal track latest, not a stale check.
  let res = null;
  try { res = await window.swarm.updateCheck(); } catch (_) { res = { kind: 'offline' }; }
  if (res && res.kind === 'offline') {
    confirmModalInfo('Не удалось проверить обновления — нет связи. Попробую ещё раз позже.');
    return;
  }
  localStorage.setItem('swarm.update.lastCheck', String(Date.now()));
  if (!res || res.kind === 'none') {
    updateState = res;
    renderUpdatePill();
    alertNoUpdate();
    return;
  }
  if (updateState && updateState.kind !== 'none' && updateState.version !== res.version) {
    confirmModalInfo('Доступна более новая версия ' + res.version + ' (раньше предлагалась ' + updateState.version + ').');
  }
  updateState = res;
  renderUpdatePill();

  const st = updateState;
  let forceInstaller = false;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal update">
      <div class="modal-title">Обновление ${st.version}</div>
      <div class="modal-msg upd-notes"></div>
      <div class="upd-progress" hidden><div class="upd-bar"></div></div>
      <div class="modal-actions">
        <button class="modal-cancel upd-later">Позже</button>
        <button class="modal-ok neutral upd-go"></button>
      </div>
    </div>`;
  overlay.querySelector('.upd-notes').textContent =
    (st.kind === 'installer' ? 'Изменился рантайм — нужен полный установщик.\n\n' : '')
    + (st.notes || '');
  const goBtn = overlay.querySelector('.upd-go');
  goBtn.textContent = st.kind === 'asar' ? 'Обновить и перезапустить' : 'Скачать установщик';
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('.upd-later').addEventListener('click', () => {
    localStorage.setItem('swarm.update.snooze', st.version);
    renderUpdatePill(); close();
  });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && !goBtn.disabled) close(); });

  goBtn.addEventListener('click', async () => {
    goBtn.disabled = true;
    // Re-check once more right before download so we never fetch a superseded build.
    let fresh = st;
    try {
      const latest = await window.swarm.updateCheck();
      if (latest && latest.kind === 'offline') {
        // Перепроверить не вышло — качаем то, про что уже знаем; если сети правда нет,
        // об этом честно скажет сама загрузка.
      } else if (latest && latest.kind !== 'none') {
        if (latest.version !== st.version) {
          confirmModalInfo('Пока решали — вышла ' + latest.version + '. Скачиваю её.');
        }
        fresh = latest;
        updateState = latest;
        renderUpdatePill();
        overlay.querySelector('.modal-title').textContent = 'Обновление ' + latest.version;
      } else {
        updateState = latest;
        renderUpdatePill();
        close();
        alertNoUpdate();
        return;
      }
    } catch (_) { /* keep st */ }

    // After a failed asar-swap we stay on the installer path for this modal.
    const useInstaller = forceInstaller || fresh.kind !== 'asar';
    // Уже лежит рядом — качать нечего, нажали именно «перезапустить».
    if (!useInstaller && updateArmed === fresh.version) {
      window.swarm.updateRelaunch();
      return;
    }
    if (!useInstaller) {
      const prog = overlay.querySelector('.upd-progress');
      const bar = overlay.querySelector('.upd-bar');
      prog.hidden = false;
      const off = window.swarm.onUpdateProgress((pct) => { bar.style.width = pct + '%'; });
      // Через armUpdate, а не своим applyPayload: тихая загрузка этой же версии могла уже
      // идти, и вторая писала бы в тот же файл.
      const res = await armUpdate(fresh);
      off();
      if (res && res.ok) {
        bar.style.width = '100%';
        window.swarm.updateRelaunch();
      }
      else {
        prog.hidden = true;
        const err = (res && res.error) || 'ошибка';
        overlay.querySelector('.upd-notes').textContent =
          'Не удалось обновить in-place: ' + err + '\n\nМожно скачать полный установщик.';
        goBtn.textContent = 'Скачать установщик';
        goBtn.disabled = false;
        forceInstaller = true;
      }
    } else {
      const u = fresh.installers[window.swarm.platform === 'win32' ? 'exe' : 'dmg'];
      const fname = (u || '').split('/').pop() || 'installer';
      const prog = overlay.querySelector('.upd-progress');
      const bar = overlay.querySelector('.upd-bar');
      const laterBtn = overlay.querySelector('.upd-later');
      goBtn.textContent = 'Скачиваю…';
      laterBtn.disabled = true;
      prog.hidden = false;
      bar.style.width = '0%';
      const off = window.swarm.onUpdateProgress((pct) => { bar.style.width = pct + '%'; });
      const res = await window.swarm.updateDownloadInstaller(u, fname);
      off();
      if (res && res.ok) {
        bar.style.width = '100%';
        close();
        confirmModalInfo('Установщик скачан в «Загрузки».');
      } else {
        prog.hidden = true;
        laterBtn.disabled = false;
        goBtn.textContent = 'Скачать установщик';
        goBtn.disabled = false;
        overlay.querySelector('.upd-notes').textContent =
          'Не удалось скачать установщик: ' + ((res && res.error) || 'ошибка');
      }
    }
  });
}

// initial + periodic checks (throttled)
setTimeout(() => checkForUpdate(false), 3000);
setInterval(() => {
  const last = Number(localStorage.getItem('swarm.update.lastCheck') || 0);
  if (Date.now() - last >= UPDATE_POLL_MS) checkForUpdate(false);
}, 30 * 60 * 1000);

document.getElementById('update-pill').addEventListener('click', openUpdateModal);

// --- «где я сейчас» ---------------------------------------------------------------------
// Одно положение на всё приложение, а не на вкладку: уходит человек, а не агент. Оно
// отвечает на два вопроса разом — что уезжает в телегу и можно ли маку спать (почему выбор
// руками, а не по простою мыши — см. tgPresence в main.js).
//
// В строке состояния — ОДНА иконка: где ты сейчас. Прошлая кнопка была выключателем с двумя
// подписями («отошёл» / «меня нет»), и обе читались как объявление об отсутствии — по
// выключенной было не понять, включено что-нибудь или нет. Выбор переехал в список.
//
// Положение живёт в main и приезжает оттуда же, чем бы его ни поменяли — этим списком,
// отвязкой группы в настройках или привязкой новой с телефона.
//
// Подписи — целыми фразами, как человек сказал бы вслух, и это не вкусовщина. Рубленое
// «разрешения стоят» читалось как «разрешения выданы», то есть ровно наоборот — а цена
// ошибки здесь в том, что человек уходит, думая, будто агенту всё позволено. Обрывки вроде
// «потом итог» экономят три слова и теряют смысл целиком.
//
// Каждая подпись отвечает на один вопрос: что будет, пока это положение включено. Про то,
// чего НЕ будет, не пишем: «за компом» — обычная работа, и перечислять при ней замолчавшую
// телегу значит объяснять человеку за клавиатурой, чего он лишён.
//
// Место есть: подпись лежит своей строкой под именем, в меню 240–340px её хватает на две.
const PRESENCE = [
  { id: 'desk', icon: 'monitor', name: 'за компом', hint: 'Всё как обычно: агенты спрашивают вас прямо в окне.' },
  { id: 'phone', icon: 'phone', name: 'за телефоном', hint: 'Вопросы и итоги приходят в телеграм, отвечать можно оттуда, и компьютер не уснёт.', needsBot: true },
];
// Ночного режима в этом списке больше НЕТ, и это не уборка, а разделение двух разных вопросов.
// «Где я» отвечает, куда писать ЧЕЛОВЕКУ; ночной режим — каким ВКЛАДКАМ разрешено работать без
// него. Пока они делили одно место, ответы спорили: человек с телефоном, а все вкладки отданы —
// что показывать? Теперь ночь живёт своей кнопкой рядом (луна), а «включена» она тогда, когда
// отданы все вкладки.
const presencePill = document.getElementById('presence-pill');
const presenceMenu = document.getElementById('presence-menu');
let presenceNow = 'desk';
// Привязан ли бот. Решает не видимость кнопки (ночь бота не требует), а доступность одного
// пункта — «за телефоном».
let presenceBot = false;

function presenceItem(id) {
  return PRESENCE.find((p) => p.id === id) || PRESENCE[0];
}

// Красим нижнюю панель, пока положение «за телефоном». Иконки для этого мало: садясь за
// стол, человек смотрит на окно целиком, а не на значки в углу, — а знать, что приложение
// всё ещё считает его ушедшим, надо сразу (иначе телефон продолжает жужжать, а мак не
// спит). Цвет и правила — в styles.css, body.presence-phone.
function paintPresence() {
  document.body.classList.toggle('presence-phone', presenceNow === 'phone');
  // Ночь красит панель по своему счёту вкладок, а не по «где я» — см. renderNightPill.
}

function renderPresencePill(st) {
  // Кнопки нет ровно в одном случае: группа не привязана — обещать «всё уйдёт в телегу»
  // там, где телеги ещё нет, значит обещать несуществующее.
  //
  // Прятали её ещё и при галке «писать всегда», и это было ошибкой: положение при этом
  // продолжало жить и переключаться командой /phone, а показать его было негде. Человек
  // возвращался за стол, а мак не спал и агенты во всех вкладках отказывались показывать
  // варианты выбора — вернуть можно было только с телефона. Галки больше нет, положение
  // одно, и видно его всегда.
  //
  // А вот без бота кнопки нет снова: ночной режим уехал отсюда на свою луну, и без телеги
  // выбирать здесь стало нечего.
  presenceBot = !!(st && st.chatId != null);
  presencePill.hidden = !presenceBot;
  presenceNow = (st && st.presence) || 'desk';
  paintPresence();
  const it = presenceItem(presenceNow);
  presencePill.classList.toggle('is-on', presenceNow !== 'desk');
  presencePill.innerHTML = ICONS[it.icon];
  presencePill.title = `Где я: ${it.name}. ${it.hint}`;
}

function openPresenceMenu() {
  presenceMenu.innerHTML = '';
  for (const p of PRESENCE) {
    const b = document.createElement('button');
    b.className = 'cmd-item presence-item' + (p.id === presenceNow ? ' is-now' : '');
    // Без бота «за телефоном» выбирать нечем — но пункт остаётся на месте и с объяснением:
    // исчезнувший пункт читается как «такого режима нет», а не как «сначала подключи бота».
    if (p.needsBot && !presenceBot) b.disabled = true;
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.innerHTML = ICONS[p.icon];
    const name = document.createElement('span');
    name.className = 'cmd-name';
    name.textContent = p.name;
    const hint = document.createElement('span');
    hint.className = 'cmd-hint';
    hint.textContent = b.disabled ? 'Сначала подключите бота в настройках.' : p.hint;
    b.append(ic, name, hint);
    b.addEventListener('click', async () => {
      closePresenceMenu();
      renderPresencePill(await window.swarm.telegram.setPresence(p.id));
    });
    presenceMenu.appendChild(b);
  }
  presenceMenu.classList.remove('hidden');
  placeMenuUnder(presenceMenu, presencePill);
  setTimeout(() => document.addEventListener('mousedown', outsideClosePresence), 0);
}

function closePresenceMenu() {
  presenceMenu.classList.add('hidden');
  document.removeEventListener('mousedown', outsideClosePresence);
}

function outsideClosePresence(e) {
  if (!presenceMenu.contains(e.target) && !presencePill.contains(e.target)) closePresenceMenu();
}

presencePill.addEventListener('click', (e) => {
  e.stopPropagation();
  if (presenceMenu.classList.contains('hidden')) openPresenceMenu();
  else closePresenceMenu();
});
window.swarm.telegram.onState(renderPresencePill);
window.swarm.telegram.state().then(renderPresencePill).catch(() => {});

// --- значок мандата ---------------------------------------------------------------------
// Что вкладки делали без человека, рассказывают они сами: агент пишет итог, закончив задачу
// (night.js summaryNote), и человек читает его, открыв вкладку. Сводки, собранной свормом по
// следам, здесь больше нет — она пересказывала поведение вкладок, а не их работу.
//
// Значку осталось одно дело, и оно про НАСТОЯЩЕЕ: сколько вкладок сейчас работает без человека
// и не забыт ли включённый ночной режим.
const nightPill = document.getElementById('night-pill');
let nightNow = { on: false, typed: false };

// Сколько вкладок работает без человека прямо сейчас. Считаем по своим записям, а не по числу
// из main: карточки и значок должны говорить одно и то же в один и тот же миг.
function autoTabsHere() {
  let n = 0;
  for (const s of sessions.values()) if (s && s.auto) n++;
  return n;
}

// «4 вкладок» — заметная небрежность на самом видном месте панели. Формы русского счёта:
// 1 вкладка, 2–4 вкладки, 5+ вкладок (и 11–14 — тоже «вкладок»).
function tabsWord(n) {
  const t = n % 100;
  if (t >= 11 && t <= 14) return 'вкладок';
  const o = n % 10;
  if (o === 1) return 'вкладка';
  if (o >= 2 && o <= 4) return 'вкладки';
  return 'вкладок';
}

function renderNightPill(st) {
  if (st) nightNow = st;
  const n = autoTabsHere();
  const all = !!nightNow.on;
  document.body.classList.toggle('night-all', all);
  // Кнопка стоит в панели ВСЕГДА: это единственная дверь к «отдать все вкладки разом», и
  // прятать её, пока ничего не отдано, значило бы прятать саму функцию. Раньше эта дверь была
  // пунктом в списке «где я» — там она спорила с вопросом «где человек» и путала обоих.
  nightPill.hidden = false;
  nightPill.classList.toggle('is-quiet', !n);
  const say = (text, title) => {
    // Луна рисуется иконкой, а не эмодзи: эмодзи в этой панели выглядит наклейкой поверх
    // интерфейса, а рядом стоят такие же значки-кнопки, нарисованные линией.
    nightPill.innerHTML = `<span class="ic">${ICONS.moon}</span>`;
    if (text) nightPill.appendChild(Object.assign(document.createElement('span'), { className: 'tx', textContent: text }));
    nightPill.title = title;
  };
  if (all && nightNow.typed) {
    // Ночь снимают руками, значит забыть про неё — самый вероятный промах. Панель уже
    // крашеная, но за клавиатурой человек смотрит в терминал, а не на её край.
    say('ночной режим включён',
      'Вы за клавиатурой, а без вас работают все вкладки. Клик — список: забрать их себе.');
  } else if (all) {
    say('ночной режим', 'Без вас работают все вкладки: решают обратимое сами, на дорогом'
      + ' останавливаются. Клик — список: отдать все или забрать себе.');
  } else if (n) {
    // Часть вкладок отдана. Это видно и по карточкам (они фиолетовые), но счётчик отвечает на
    // другой вопрос — «сколько всего сейчас работает без меня».
    say(`${n} ${tabsWord(n)} в ночном`, 'Столько вкладок работает без вас: решают обратимое'
      + ' сами, на дорогом останавливаются. Клик — список: отдать все или забрать себе.');
  } else {
    say('', 'Ночной режим: отдать вкладки работать без вас. Одну — полумесяцем на её карточке,'
      + ' все разом — отсюда.');
  }
  renderGate();
}

// Список у луны, а не переключатель под курсором. Причина та же, по какой у счётчика появилось
// подтверждение: кнопка в панели трогает СРАЗУ ВСЕ вкладки, и промах по ней стоит либо
// брошенной работы, либо отданных вкладок, которых человек не отдавал. Пункты называют
// действие целиком, и мимо них не промахнёшься.
const nightMenu = document.getElementById('night-menu');

function nightMenuItems() {
  const n = autoTabsHere();
  const total = sessions.size;
  return [
    {
      id: 'all', icon: 'moon', name: 'отдать все вкладки',
      hint: total - n > 0
        ? `Ещё ${total - n} ${tabsWord(total - n)} перейдут работать без вас.`
        : 'Уже отданы все.',
      off: total === 0 || n >= total,
    },
    {
      id: 'none', icon: 'monitor', name: 'забрать все себе',
      hint: n ? `${n} ${tabsWord(n)} вернутся вам и будут ждать ответа на каждом шаге.` : 'Отдавать нечего.',
      off: !n,
    },
  ];
}

function openNightMenu() {
  nightMenu.innerHTML = '';
  for (const it of nightMenuItems()) {
    const b = document.createElement('button');
    b.className = 'cmd-item presence-item';
    b.disabled = it.off;
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.innerHTML = ICONS[it.icon];
    const name = document.createElement('span');
    name.className = 'cmd-name';
    name.textContent = it.name;
    const hint = document.createElement('span');
    hint.className = 'cmd-hint';
    hint.textContent = it.hint;
    b.append(ic, name, hint);
    b.addEventListener('click', () => { closeNightMenu(); nightBulk(it.id); });
    nightMenu.appendChild(b);
  }
  nightMenu.classList.remove('hidden');
  placeMenuUnder(nightMenu, nightPill);
  setTimeout(() => document.addEventListener('mousedown', outsideCloseNight), 0);
}

function closeNightMenu() {
  nightMenu.classList.add('hidden');
  document.removeEventListener('mousedown', outsideCloseNight);
}

function outsideCloseNight(e) {
  if (!nightMenu.contains(e.target) && !nightPill.contains(e.target)) closeNightMenu();
}

// Отдать все или забрать все. Забрать — с подтверждением: вкладки бросят работу без человека и
// встанут ждать его на каждом шаге, и промах по кнопке в панели стоил бы этого всем разом.
// Отдать подтверждения не требует: обратное движение стоит одного клика и ничего не ломает.
async function nightBulk(kind) {
  if (kind === 'none') {
    const n = autoTabsHere();
    if (!n) return;
    const ok = await confirmModal(
      `Забрать себе ${n} ${tabsWord(n)}? Они выйдут из ночного режима и перестанут решать без вас`
        + ' — на каждом шаге будут ждать вашего ответа.',
      'Забрать все',
    );
    if (!ok) return;
  }
  try { await window.swarm.night.setAll(kind === 'all'); } catch (_) { /* main ответит пушем */ }
}

nightPill.addEventListener('click', (e) => {
  e.stopPropagation();
  if (nightMenu.classList.contains('hidden')) openNightMenu();
  else closeNightMenu();
});

window.swarm.night.onState(renderNightPill);
window.swarm.night.state().then(renderNightPill).catch(() => {});

document.getElementById('new-session-folder').addEventListener('click', createSessionInFolder);
document.getElementById('settings-btn').addEventListener('click', () => showSettingsModal());
cmdBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleCmdMenu(); });
gitBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleGitMenu(); });
gitDiffBtn.addEventListener('click', (e) => { e.stopPropagation(); openDiffOverlay(); });

// Set the button icons (Lucide SVGs).
document.querySelector('#new-session-folder .ic').innerHTML = ICONS.plus;
document.querySelector('#cmd-menu-btn .ic').innerHTML = ICONS.command;
document.querySelector('#settings-btn .ic').innerHTML = ICONS.gear;

// Restore previous tabs (folders + names + Claude conversation ids). With resume on,
// each Claude tab reopens its own dialogue (`--resume <id>`, or the legacy `--resume
// swarm-…` for tabs saved by older builds); otherwise a fresh agent in that folder.
async function restoreOrStart() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem('swarm.tabs') || '[]'); } catch (_) {}
  saved = Array.isArray(saved) ? saved.filter((t) => t && t.cwd) : [];
  if (!saved.length) { createSession(); return; }
  // Один разговор — одной вкладке. В сохранённых вкладках один и тот же claudeSessionId
  // может стоять у нескольких: так бывало, когда вкладка без своей стенограммы забирала
  // сканом папки чужой живой разговор и запоминала его id (в main это теперь закрыто
  // резервом, но у тех, кто уже пострадал, дубли лежат в localStorage и сами не уйдут).
  //
  // Восстанавливать по такому id можно только ПЕРВУЮ вкладку. Остальные стартуют чистыми:
  // три вкладки на одном разговоре — это одна история в трёх окнах, чужой статус на чужой
  // вкладке и «сессия не найдена» от Клода, которому один и тот же id называют дважды.
  const usedIds = new Set();
  const usedKeys = new Set();
  for (const t of saved) {
    const dupId = !!t.claudeSessionId && usedIds.has(t.claudeSessionId);
    const dupKey = !!t.sessionKey && usedKeys.has(t.sessionKey);
    if (t.claudeSessionId && !dupId) usedIds.add(t.claudeSessionId);
    if (t.sessionKey && !dupKey) usedKeys.add(t.sessionKey);
    await createSession({
      cwd: t.cwd,
      name: t.name,
      // A clean terminal restores as clean (no command). Otherwise always pass a
      // cmd so restore never pops the picker — legacy saved tabs may lack `cmd`;
      // fall back to the default agent, as before.
      blank: t.blank || undefined,
      cmd: t.blank ? undefined : (t.cmd || launch.cmd),
      flags: t.blank ? undefined : (t.flags != null ? t.flags : undefined),
      // Дубликат зацепки — не зацепка: вкладка открывается свежей, а не второй копией
      // чужого разговора.
      sessionKey: (dupKey ? null : t.sessionKey) || undefined,
      claudeSessionId: (dupId ? null : t.claudeSessionId) || undefined,
      tabKey: t.tabKey || undefined,   // same tab → same Telegram topic as before
      auto: !!t.auto,                  // отданная вкладка остаётся отданной
      // Восстановление — не рождение: вкладка возвращается ровно такой, какой была. Без этой
      // отметки первая же отданная вкладка делала бы «ночь включена» (отдана единственная
      // живая), и следующие восстанавливались бы отданными, хотя человек их не отдавал.
      restored: true,
      resume: !!(resumeSessions && ((t.claudeSessionId && !dupId) || (t.sessionKey && !dupKey))),
    });
  }
  const first = sessions.keys().next();
  if (!first.done) activate(first.value);
}

// Restore saved prefs, then the tabs.
applyTabStyle();
applyLayout(localStorage.getItem('swarm.layout') || 'layout-rail');
applyNotify(localStorage.getItem('swarm.notify') !== '0'); // master notifications on/off
// Tell main the saved hooks pref BEFORE restoring sessions, so swarm-settings.json
// carries (or omits) the hooks block before the first claude spawn.
window.swarm.setHooksEnabled(hooksEnabled);
window.swarm.setPermissionMode(permMode); // тем же порядком: режим должен быть до первой вкладки
window.swarm.setRestart({ enabled: restartOn, threshold: restartPct }); // порог самоперезапуска
// Голос из телеги. Chromium декодирует Opus сам, поэтому ffmpeg приложению не нужен:
// декодируем как есть, потом пересобираем в моно 16 кГц через OfflineAudioContext — ровно
// то, что ест whisper.cpp. Обратно уходит Float32, WAV собирает main.
window.swarm.onDecodeAudio(async ({ reqId, bytes }) => {
  try {
    const raw = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const ctx = new AudioContext();
    const decoded = await ctx.decodeAudioData(raw);
    ctx.close();
    const frames = Math.max(1, Math.ceil(decoded.duration * 16000));
    const off = new OfflineAudioContext(1, frames, 16000);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    window.swarm.audioDecoded(reqId, out.getChannelData(0));
  } catch (e) {
    window.swarm.audioDecoded(reqId, null, String((e && e.message) || e));
  }
});

// /new из телеги: main знает папку, но вкладку умеет делать только рендерер.
window.swarm.onCreateTab(({ cwd }) => createSession({ cwd }));

// Тему переименовали в телеге — переносим имя на вкладку. Обратно в телегу оно не поедет:
// main сравнивает имя с названием темы и на совпадении молчит, так что круга не возникает.
window.swarm.onRenameTab(({ id, name }) => {
  const s = sessions.get(String(id));
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (!s || !clean) return;
  s.tab.querySelector('.label').textContent = clean;
  persistTabs();          // имя переживает перезапуск, как и при переименовании мышью
});

// Кнопка «закрыть вкладку» в телеге. Через тот же closeSession, что и крестик: иначе
// остались бы висеть xterm, DOM и место в раскладке.
window.swarm.onCloseTab(({ id }) => closeSession(String(id)));

// Самоперезапуск: агент разрешил и прислал промпт, main просит стартовать свежую сессию.
// Ярлык разговора заводится ЗДЕСЬ, потому что храним его мы — и он обязан быть новым. Со
// старым вкладка после перезапуска приложения вернулась бы в тот самый разбухший разговор,
// из которого мы только что ушли, и все перезапуски отменились бы одним релончем.
window.swarm.onRestartAgent(async ({ id, prompt }) => {
  const sid = String(id);
  const s = sessions.get(sid);
  if (!s || s.blank) return;
  const key = resumeSessions && RESUME_API.supports(s.cmd) ? RESUME_API.newSessionKey() : null;
  // Ответ на вызов нам не нужен: и ярлык, и новый claudeSessionId приезжают известиями
  // (session:restarted и session:claude), потому что напечатать запуск может не только этот
  // вызов, но и main сам, позже — когда прежний агент вышел не сразу. Сохранение по ответу
  // теряло бы ярлык именно в этом случае.
  await window.swarm.relaunchSession({ id: sid, sessionKey: key, prompt });
});

// Строки в журнал приложения: утром видно не только «работал восемь часов», но и сколько раз
// начинал заново — и почему не начал, если не начал. Не ошибки, красный значок не зажигаем.
// Свой файл рядом с настройками у перезапуска тоже есть, но у журнала есть кнопка, а у файла нет.
function restartJournal(id, text) {
  const s = sessions.get(String(id));
  const name = s ? s.tab.querySelector('.label').textContent : 'вкладка';
  recordLog(name, 'info', text);
}

window.swarm.onRestarted(({ id, n, sessionKey }) => {
  restartJournal(id, `перезапуск №${n}: контекст заполнился, начал с чистой сессии`);
  // Ярлык нового разговора. Старый указывает на брошенный, и оставить его — значит однажды
  // вернуться в него: после релонча сворма вкладка ищет разговор сначала по id, а если того на
  // диске нет — по ИМЕНИ, то есть по ярлыку.
  const s = sessions.get(String(id));
  if (!s) return;
  s.sessionKey = sessionKey || null;
  persistTabs();
});

// Всё, что случилось по дороге и НЕ кончилось перезапуском: «не сейчас», нет ответа, отмена.
// Без этого функция молчала бы ровно в тех случаях, когда человек и хочет знать, чем она занята.
window.swarm.onRestartNote(({ id, text }) => restartJournal(id, text));

// Разрешение на перезапуск получено, а вкладка всё живёт. Причин у этого пять, и четыре из них
// проходят сами за десять минут (вкладка работает, открыта рамка, считают сабагенты). Пятая — нет:
// под непрочитанным ответом часы разрешения стоят намеренно, и вкладка будет ждать твоих глаз
// хоть сутки. Со стороны это неотличимо от сломанной функции — вкладка живая, работа идёт, а
// перезапуска нет, — поэтому она про это говорит. Открыть её или ответить ей: оба снимают пометку.
const HOLD_LABEL = { unread: 'ждёт взгляда' };
const HOLD_TITLE = {
  unread: 'Перезапуск готов, но здесь лежит ответ, которого ты ещё не видел.'
    + ' Открой вкладку или ответь ей — и она перезапустится.',
};
window.swarm.onRestartHold(({ id, hold }) => {
  const s = sessions.get(String(id));
  const el = s && s.tab.querySelector('.hold');
  if (!el) return;
  const label = HOLD_LABEL[hold] || '';
  el.textContent = label;
  el.title = HOLD_TITLE[hold] || '';
  el.hidden = !label;
});
try { JSON.parse(localStorage.getItem('swarm.collapsed') || '[]').forEach((c) => collapsedFolders.add(c)); } catch (_) {}
restoreOrStart();

// Keep the branch bar live: poll the ACTIVE folder's git status every 2.5s so a
// branch switch / new changes that `claude` makes right in the terminal show up
// on their own — like VS Code's live git. Cheap: all-local git calls, active
// folder only. Skips while a menu action's transient message is showing so it
// doesn't clobber "обновляю…".
setInterval(() => {
  if (gitMsgEl.textContent) return;
  refreshGit();
}, 2500);

// Auto-fetch the active folder every 3 minutes so "↓N can pull" appears without
// user action. Network op, so it's on its own slow timer with GIT_TERMINAL_PROMPT=0
// (set in git.js) — an auth-needing repo fails fast and is ignored here (the manual
// "Обновить" button surfaces the login hint). No fetch when the folder isn't a repo.
setInterval(async () => {
  const forId = activeId;
  if (!gitInfo || !gitInfo.isRepo) return;
  const cwd = sessions.get(activeId)?.cwd;
  if (!cwd) return;
  try { await window.swarm.git.fetch(cwd); } catch (_) {}
  if (forId === activeId) refreshGit();
}, 180000);
