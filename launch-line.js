'use strict';
// What a new tab SEES when it starts.
//
// A tab is a real login shell, and the agent is started by TYPING a command into it
// (main.js session:create). The shell echoes what it's told, so everything swarm adds
// to that command — the statusline settings path, the ask rule (agent-rules.js), the
// permission mode, the session id — is the first thing the user reads in a fresh tab.
// The ask rule alone is half a thousand characters of Russian prose: six wrapped lines
// at 80 columns, and xterm smears them into garbage when the tab's first resize reflows
// them. This module is the two answers to that, and neither changes a byte of what
// claude actually receives:
//
//   envPassing() — long values travel in the shell's ENVIRONMENT, so the line only says
//     `--append-system-prompt "$SWARM_ASK_RULE"`.
//   clearPrefix() — a `clear` in front of the command wipes even that, so the tab opens
//     on the agent instead of on our bookkeeping.
//
// Own module (and own test) rather than four functions in main because the cost of a
// mistake here is invisible in review and loud in use: a reference the shell doesn't
// expand hands claude a literal `$SWARM_ASK_RULE` as its system prompt, or a settings
// path that doesn't exist — and claude then refuses to start, so the tab greets its
// owner with a dead shell instead of an agent.

// Shells whose `"$VAR"` means what we think it means. Not a guess list: each of these
// expands a double-quoted reference the POSIX way (fish and csh included — they differ
// in plenty of things, but not in this one).
const POSIX_SHELLS = ['sh', 'bash', 'zsh', 'ksh', 'mksh', 'dash', 'ash', 'fish', 'csh', 'tcsh'];

// 'posix' | 'cmd' | 'powershell' | null. null means «unknown shell» (nushell, xonsh,
// elvish, something homegrown in $SHELL) — we then pass values inline instead of
// guessing a syntax, see envPassing.
//
// Split on both separators by hand instead of path.basename: this reads $SHELL/%COMSPEC%,
// and a `C:\…\cmd.exe` handed to a POSIX path.basename comes back whole — the family
// would be «unknown» and every Windows tab would take the fallback for no reason.
function shellFamily(shellPath) {
  const base = String(shellPath || '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  if (base === 'cmd') return 'cmd';
  if (base === 'powershell' || base === 'pwsh') return 'powershell';
  if (POSIX_SHELLS.includes(base)) return 'posix';
  return null;
}

// A collector for the values we'd rather not show. `ref(name, value)` remembers the
// value under that name and returns how the command line should spell it — an
// environment reference for a shell we recognise, the plain quoted value otherwise.
// `env` is what main merges into pty.spawn's environment.
function envPassing(shellPath) {
  const family = shellFamily(shellPath);
  const env = {};
  return {
    env,
    ref(name, value) {
      const v = String(value == null ? '' : value);
      if (family === 'posix') { env[name] = v; return `"$${name}"`; }
      if (family === 'cmd') { env[name] = v; return `"%${name}%"`; }
      if (family === 'powershell') { env[name] = v; return `"$env:${name}"`; }
      return `"${v}"`;
    },
  };
}

// Метки Клод-сессии, ЗАПУСТИВШЕЙ сам сворм. Их нельзя передавать вкладкам.
//
// Сворм отдаёт вкладке своё окружение целиком — так вкладка получает вашу авторизацию и
// ваши настройки. Но если сворм запустили из сессии Клода (из терминала под агентом или
// руками агента), в этом окружении лежат метки той сессии. Дальше начинается странное:
//
//   • CLAUDE_CODE_CHILD_SESSION заставляет Клода считать себя дочерней сессией и НЕ
//     сохранять журнал. Журнал — главный источник статуса вкладки и дословного текста
//     вопроса, так что вкладка тихо теряет цвет, уведомления и вопросы в телеграме.
//     Видно это только по строчке «Transcript saving is off» в самой вкладке;
//   • CLAUDE_CODE_SESSION_ID и CLAUDE_PID — это чужая сессия и чужой процесс.
//
// Стираем именно перечисленное, а не всё по префиксу CLAUDE_: CLAUDE_CONFIG_DIR задаёт
// аккаунт (на нём держится алиас личного аккаунта), а ANTHROPIC_* — авторизация. Их
// потерять нельзя. Оболочка вкладки логин-овая, поэтому всё, что человек прописал себе в
// профиле, вернётся само.
const INHERITED_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
];

function tabEnv(parentEnv) {
  const env = Object.assign({}, parentEnv || {});
  for (const name of INHERITED_SESSION_VARS) delete env[name];
  return env;
}

// Прокси для вкладок агента (Настройки → Общее → Сеть). Корпоративная сеть, где наружу
// только через прокси, или Charles/Fiddler, чтобы посмотреть трафик Клода.
//
// Ставится ТОЛЬКО в окружение вкладки с агентом — не в process.env: сам сворм (обновления,
// телега) ходит в сеть как раньше, а панель терминала ⌘J остаётся обычной оболочкой
// человека. Пустая строка — не вмешиваться: что пришло из системы, то и остаётся.
//
// Схема необязательна: «host:8080» значит http://host:8080 — так прокси обычно и диктуют.
// Неразборчивое — тоже «не вмешиваться»: вкладка без прокси хотя бы скажет внятную сетевую
// ошибку, а мусор в HTTPS_PROXY роняет Клода на старте непонятно чем.
function normalizeProxy(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : 'http://' + t;
  let u;
  try { u = new URL(withScheme); } catch (_) { return ''; }
  // SOCKS Claude Code не поддерживает (документация, «Enterprise network configuration»).
  if (!/^https?:$/.test(u.protocol) || !u.hostname) return '';
  return withScheme;
}

// Адреса, которые в обход прокси нужны всегда: локальные MCP-серверы и инструменты,
// которые Клод зовёт по localhost. Через корпоративный прокси они бы просто пропали.
const LOCAL_NO_PROXY = ['localhost', '127.0.0.1', '::1'];

function proxyEnv(env, proxy) {
  const out = Object.assign({}, env || {});
  const url = normalizeProxy(proxy);
  if (!url) return out;
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) out[name] = url;
  // Свой NO_PROXY человека дополняем, а не затираем: в нём могут быть внутренние хосты.
  const have = String(out.NO_PROXY || out.no_proxy || '').split(',').map((s) => s.trim()).filter(Boolean);
  const noProxy = have.concat(LOCAL_NO_PROXY.filter((h) => !have.includes(h))).join(',');
  out.NO_PROXY = noProxy;
  out.no_proxy = noProxy;
  return out;
}

// Run `clear` before the command. On an xterm `clear` also drops the scrollback
// (ESC[3J), so scrolling up in a fresh tab shows the conversation and nothing else.
// cmd.exe has its own name for it and its own separator; every other shell we can land
// in separates with `;` and has `clear` on PATH. If it somehow doesn't, the worst case
// is one «command not found» above the agent — the command after the separator still
// runs, which is why this is a prefix and not `clear && …`.
function clearPrefix(shellPath) {
  return shellFamily(shellPath) === 'cmd' ? 'cls&' : 'clear; ';
}

module.exports = { shellFamily, envPassing, clearPrefix, tabEnv, normalizeProxy, proxyEnv, INHERITED_SESSION_VARS };
