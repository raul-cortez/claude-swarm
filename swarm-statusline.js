#!/usr/bin/env node
// swarm-statusline.js — the statusline Claude Swarm injects into every Claude
// session it launches (via `--settings`, see main.js). It exists so the context
// progress bar on each tab works OUT OF THE BOX: the app can't measure context
// itself, it scrapes a "NN%" out of the statusline text — and stock Claude prints
// no such line. This one does.
//
// Runs under Electron-as-node (ELECTRON_RUN_AS_NODE=1) so it needs no separately
// installed Node. Output is plain text with ANSI colour; the app reads it with the
// colour stripped, so state is marked by GLYPHS, never by colour alone.
//
// Format: <model> │ <dir> ███░░░░░░░ 45% 1M │ 🔧 #162 task
//                                    ^^^^^ this % is what the app parses — it takes
// the FIRST one in the line, so nothing carrying a % may go before the context bar.
//
// Расхода подписки в строке БОЛЬШЕ НЕТ, и это не потеря. Окна лимитов не про вкладку, а про
// аккаунт: одни и те же числа честно повторялись в терминале столько раз, сколько открыто
// вкладок этого конфига, и были видны только у той, что на экране. Теперь они в нижней панели
// приложения — одной для всех (renderUsagePills в renderer.js, пороги в subs.js), а агент
// получает их текстом в начало каждого хода, вместе с ИМЕНЕМ своей подписки (usageNote в
// hooks/swarm-signal.mjs). Снимок расхода этот скрипт по-прежнему пишет — он и есть источник
// для всех троих (см. writeUsage ниже).

const fs = require('fs');
const path = require('path');
const os = require('os');

// --- чужая строка статуса: не «или-или», а «и то, и другое» -------------------
// Слот statusLine у Клода один, и наш файл (--settings) идёт верхним слоем — значит
// СВОЯ строка человека в свормовских вкладках просто не показывалась. Раньше это лечили
// галкой «своя строка статуса Swarm»: выключил — вернул себе свою, но вместе с ней потерял
// полоску контекста, лимиты и САМ ПЕРЕЗАПУСК ПО КОНТЕКСТУ, потому что процент заполнения
// приходит только отсюда. То есть выбор был между своей строкой и работающим приложением.
//
// Развилка ложная. Слот один, но никто не мешает нам ПОЗВАТЬ чужую команду и напечатать
// оба куска. Мы ничего не замещаем — мы дописываем то, чего в чужой строке нет.
//
// Порядок кусков несущий: рендерер берёт полоску контекста по ПЕРВОМУ проценту в строке
// (renderer.js, updateCtx), поэтому наш кусок идёт первым. Пусти чужой вперёд — и любой
// его процент (расход диска, покрытие тестами, что угодно) нарисуется на вкладке как
// контекст, а на этом проценте стоит и решение о перезапуске.
const FOREIGN_MS = 1000;

// Где искать чужие настройки. Слои — как у самого Клода, сверху вниз: локальные настройки
// проекта, настройки проекта, настройки пользователя. Корень конфига берём из окружения
// (`CLAUDE_CONFIG_DIR` уводит в другой конфиг целиком — у пользователя это алиасы вроде
// `claude-my`, и мы наследуем его переменные, раз запущены самим Клодом), иначе — из адреса
// стенограммы, иначе — ~/.claude.
function configRoot(data, env) {
  const e = (env || {}).CLAUDE_CONFIG_DIR;
  if (e) return e;
  // <корень>/projects/<слаг>/<id>.jsonl — корень на два уровня выше папки проекта.
  const t = data && data.transcript_path;
  if (t) {
    const projects = path.dirname(path.dirname(String(t)));
    if (path.basename(projects) === 'projects') return path.dirname(projects);
  }
  return path.join(os.homedir(), '.claude');
}

function settingsLayers(data, env) {
  const ws = (data && data.workspace) || {};
  const proj = ws.project_dir || ws.current_dir || '';
  const out = [];
  if (proj) {
    out.push(path.join(proj, '.claude', 'settings.local.json'));
    out.push(path.join(proj, '.claude', 'settings.json'));
  }
  out.push(path.join(configRoot(data, env), 'settings.json'));
  return out;
}

// Наша же команда, увиденная со стороны. Человек мог прописать её себе сам (или она
// осталась от прежних версий) — позвать её отсюда значит уйти в кольцо: строка зовёт
// строку, и так до упора по времени на каждой перерисовке.
function isOwnCommand(cmd) {
  return /swarm-statusline/i.test(String(cmd || ''));
}

// Первая команда строки статуса, найденная по слоям. Берём только type: 'command' —
// остальные формы Клод рисует сам, и подменять его нам нечем.
function foreignCommandFrom(layers) {
  for (const raw of layers || []) {
    const sl = raw && raw.statusLine;
    if (!sl || sl.type !== 'command') continue;
    const cmd = String(sl.command || '').trim();
    if (!cmd || isOwnCommand(cmd)) continue;
    return cmd;
  }
  return '';
}

// Наш кусок ВСЕГДА первый (см. про первый процент выше). Чужой пустой — строка не меняется
// вовсе, то есть у человека без своей строки всё как было.
//
// Совпавший кусок не печатаем дважды. Случай не выдуманный: наша строка выросла из скрипта,
// который люди носили с собой, и у такого человека в конфиге лежит её ранняя копия — склейка
// честно напечатала бы одно и то же подряд. Сравниваем БЕЗ цвета: копия могла разойтись с
// оригиналом в оттенках, оставшись тем же текстом.
// И чужой кусок не печатаем ВООБЩЕ, пока в нашем нет процента. «Наш идёт первым» защищает
// полоску только тогда, когда наш процент в строке есть, — а до первого ответа модели окна
// контекста ещё нет, и мы печатаем один «Opus 5 │ repo». Первым процентом в строке тогда
// станет чужой (у кого-то там расход диска, у кого-то покрытие тестами), и вкладка нарисует
// его как контекст.
const NO_ANSI = /\x1b\[[0-9;]*m/g;
function composeLine(ours, foreign) {
  const f = String(foreign || '').replace(/[\r\n]+.*$/s, '').trim();
  if (!f) return ours;
  const bare = (s) => String(s).replace(NO_ANSI, '').trim();
  if (bare(f) === bare(ours)) return ours;
  if (/%/.test(bare(f)) && !/%/.test(bare(ours))) return ours;
  return `${ours} │ ${f}`;
}

// Позвать чужую команду тем же входом, каким Клод позвал нас. Никогда не бросает и никогда
// не висит: строка перерисовывается на каждом ходе, и чужой скрипт, задумавшийся на минуту,
// был бы виден как подтормаживающий Клод, а не как чужой скрипт.
function readForeign(data, input) {
  try {
    const files = settingsLayers(data, process.env);
    const layers = files.map((f) => {
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; }
    });
    const cmd = foreignCommandFrom(layers);
    if (!cmd) return '';
    const { spawnSync } = require('child_process');
    const cwd = (data && data.workspace && data.workspace.current_dir) || undefined;
    // SIGKILL, а не мягкий TERM: таймаут гасит оболочку, но пока жив хоть кто-то с нашей
    // трубой в руках, синхронный запуск ждёт закрытия трубы, а не смерти процесса. Чужая
    // строка, оставившая что-нибудь в фоне, подвесила бы отрисовку насовсем.
    const r = spawnSync(cmd, {
      shell: true, input, cwd, timeout: FOREIGN_MS, killSignal: 'SIGKILL',
      encoding: 'utf8', maxBuffer: 1 << 20, windowsHide: true,
    });
    return (r && r.stdout) || '';
  } catch (_) { return ''; }
}

// A task a skill pinned to this tab (writes .claude/.task-<session>). Optional:
// absent for anyone without those skills, in which case we simply render nothing.
// The mode is marked by a glyph, not colour — the app reads the line without ANSI.
const PIN_GLYPH = { groom: '🔎', task: '🔧' };

function readPin(cwd, session) {
  if (!session || /[/\\]|\.\./.test(session)) return null;
  let cur = path.resolve(cwd);
  for (let i = 0; i < 8; i++) {
    try {
      const p = path.join(cur, '.claude', `.task-${session}`);
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) { return null; }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }

  return null;
}

function renderPin(pin) {
  if (!pin || !pin.number) return '';
  const glyph = PIN_GLYPH[pin.mode] || PIN_GLYPH.task;
  const raw = String(pin.title || '').trim();
  const title = raw.length > 36 ? raw.slice(0, 35).trimEnd() + '…' : raw;
  const phase = String(pin.phase || '').trim();

  return ` \x1b[2m│\x1b[0m ${glyph} \x1b[1m#${pin.number}\x1b[0m${title ? ` \x1b[2m${title}\x1b[0m` : ''}` +
    (phase ? ` \x1b[2m·\x1b[0m \x1b[36m${phase}\x1b[0m` : '');
}

// --- the subscription budget: 5-hour window and week -------------------------
// Claude Code hands us these on stdin (rate_limits.*), so showing them costs no API
// call and no bookkeeping of our own. They are NOT always there: subscription
// accounts only, and only from the first API response of the session on. Missing ⇒
// we print nothing, because a bare "0%" is indistinguishable from a real reading.
//
// We show SPENT, the same direction as the account page on the site — so the two
// never have to be mentally inverted against each other — and round UP, because a
// spend figure must not report less than has actually gone.
//
// Пороги остались ради ответа /usage в чате (usageReport ниже): «⚠» у окна, которое почти
// кончилось. Те же числа стоят в subs.js (панель) и в hooks/swarm-signal.mjs (ворота на
// подагентов) — разойдись они, и панель говорила бы «всё в порядке» там, где хук уже
// запрещает агенту подагентов.
const LIMIT_TIGHT = 75;
const LIMIT_CRIT = 90;   // % spent at which the line says «about to run out»

function usedPct(limit) {
  const used = limit && typeof limit.used_percentage === 'number' ? limit.used_percentage : null;
  if (used == null || !isFinite(used)) return null;
  return Math.max(0, Math.min(100, Math.ceil(used)));
}

// "2ч14м" / "18м" / "3д4ч" — coarse on purpose: it's a countdown to a reset hours or
// days out, so seconds would be noise and minute-level precision matters only at the end.
function fmtEta(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}д${h}ч` : `${d}д`;
  if (h > 0) return m > 0 ? `${h}ч${m}м` : `${h}ч`;
  return `${m}м`;
}

// How full the context is, as a number. Claude auto-compacts before the window is
// truly full, so "used" is scaled against the USABLE region (window minus the
// auto-compact buffer) — that matches the number Claude itself shows, not raw
// tokens / total. Shared by the line and the snapshot below, because two answers to
// «сколько занято» differing by 16% would be worse than either of them alone.
function ctxUsed(win) {
  const remaining = win && win.remaining_percentage;
  if (remaining == null || !isFinite(remaining)) return null;
  const totalCtx = (win && win.total_tokens) || 1_000_000;
  const acw = parseInt(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '0', 10);
  const bufferPct = acw > 0 ? Math.min(100, (acw / totalCtx) * 100) : 16.5;
  const usableRemaining = Math.max(0, ((remaining - bufferPct) / (100 - bufferPct)) * 100);
  return Math.max(0, Math.min(100, Math.round(100 - usableRemaining)));
}

// 1_000_000 → "1M", 200_000 → "200K". The window size, for «62% из 1M».
function fmtTok(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : Math.round(n / 1000) + 'K';
}

// --- the same numbers as DATA, for the Telegram bridge ------------------------
// The line above is for the eye; the bridge has to ANSWER with these numbers when
// somebody asks «/usage» from a phone. Re-reading them off the rendered line would be
// the wrong source: it rounds, and it hides the reset countdown below LIMIT_TIGHT to
// save width. (Reading it is not the problem — the app keeps its own invisible copy of
// every tab's terminal, so it sees the line whether or not you're looking at that tab.
// The problem is that a rendered line is all it would have: rounded, countdown hidden.)
//
// So the statusline also drops the raw numbers beside itself as JSON, one file per
// session, and main reads them (see readUsage). Same trick as the hook's
// swarm-phrases.json: this script is COPIED into userData (provisionNodeLauncher), so
// __dirname is a writable app dir, not the read-only asar.
//
// `resetsAt` is kept as an absolute time on purpose: a snapshot can be minutes old (an
// idle tab doesn't re-render), but the countdown computed from it is still exact.
// `home` — в каком КОНФИГЕ живёт эта сессия. Аккаунтов у человека бывает несколько
// (`CLAUDE_CONFIG_DIR`, алиас вроде `claude-my`), и окна подписки у них РАЗНЫЕ. Без этого
// поля читатель снимков (ворота на подагентов в hooks/swarm-signal.mjs) взял бы самый свежий
// файл в папке и запретил подагентов на личном аккаунте из-за расхода рабочего.
function usageSnapshot(data, nowSec, home) {
  const d = data || {};
  const win = d.context_window || {};
  const rl = d.rate_limits || {};
  const limit = (l) => {
    const spent = usedPct(l);
    if (spent == null) return null;
    return { spent, resetsAt: l && typeof l.resets_at === 'number' ? l.resets_at : null };
  };
  const used = ctxUsed(win);
  return {
    at: nowSec,
    session: String(d.session_id || ''),
    home: String(home || ''),
    model: d.model?.display_name || '',
    ctx: used == null ? null : { used, total: (win && win.total_tokens) || 1_000_000 },
    five: limit(rl.five_hour),
    seven: limit(rl.seven_day),
  };
}

// The /usage answer, as chat text. It lives here, next to the numbers, so the chat and
// the tab can't drift apart on what «израсходовано» means — same direction (spent),
// same rounding, same countdown wording.
//
// The two windows are per ACCOUNT, not per tab, so they're stated once, taken from the
// freshest snapshot we have; the context is per session, so it's stated per tab. Rows
// with no snapshot are listed too, with the reason — a tab silently missing from the
// list would read as «расход нулевой».
function usageReport(rows, nowSec) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const withData = list.filter((r) => r.usage);
  const freshest = withData.map((r) => r.usage).sort((a, b) => (b.at || 0) - (a.at || 0))[0] || null;
  const out = [];

  const limitLine = (label, l) => {
    if (!l) return null;
    const eta = l.resetsAt != null && l.resetsAt > nowSec ? ` · сброс через ${fmtEta(l.resetsAt - nowSec)}` : '';
    // Тот же глиф, что в строке статуса, и по той же причине: пометка должна читаться
    // и там, где нет цвета. В чате цвета нет вовсе.
    const warn = l.spent >= LIMIT_CRIT ? '⚠ ' : '';
    return `${warn}${label} ${l.spent}%${eta}`;
  };
  const limits = freshest ? [limitLine('5 часов:', freshest.five), limitLine('7 дней:', freshest.seven)].filter(Boolean) : [];
  if (limits.length) {
    out.push('Лимиты подписки');
    out.push(...limits);
    // Числа лимитов — снимок, а не живое значение: если он старый, надо сказать, иначе
    // человек примет вчерашний расход за сегодняшний. Отсчёт до сброса от этого не
    // портится — он считается от абсолютного времени.
    const age = nowSec - (freshest.at || nowSec);
    if (age > 300) out.push(`(сняты ${fmtEta(age)} назад — вкладка с тех пор молчала)`);
  } else {
    out.push('Лимиты подписки неизвестны: Клод сообщает их только по подписке и только'
      + ' после первого ответа в сессии.');
  }

  out.push('');
  out.push(list.length > 1 ? 'Контекст по вкладкам' : 'Контекст');
  if (!list.length) out.push('Открытых вкладок нет.');
  // Самые полные сверху: список отвечает на вопрос «кого пора сжимать», а не «в каком
  // порядке открыты вкладки». Без данных — в конец, они ничего не говорят.
  const ordered = list.slice().sort((a, b) => {
    const av = a.usage && a.usage.ctx ? a.usage.ctx.used : -1;
    const bv = b.usage && b.usage.ctx ? b.usage.ctx.used : -1;
    return bv - av;
  });
  for (const r of ordered) {
    const u = r.usage;
    out.push(u && u.ctx
      ? `${u.ctx.used}% из ${fmtTok(u.ctx.total)} · ${r.name}`
      : `— · ${r.name} (${r.why || 'нет данных: статуслайн приложения в этой вкладке не работает'})`);
  }

  return out.join('\n');
}

// The whole line, from the JSON Claude Code sends on stdin. Pure so it's testable.
function renderLine(data, nowSec) {
  const model = data.model?.display_name || 'Claude';
  const cwd = data.workspace?.current_dir || process.cwd();
  const dir = path.basename(cwd);
  const session = data.session_id || '';
  const pin = renderPin(readPin(cwd, session));
  const used = ctxUsed(data.context_window);

  let ctx = '';
  if (used != null) {
    const win = fmtTok(data.context_window?.total_tokens || 1_000_000);
    const filled = Math.floor(used / 10);
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    if (used < 50) ctx = ` \x1b[32m${bar} ${used}%\x1b[0m \x1b[2m${win}\x1b[0m`;
    else if (used < 65) ctx = ` \x1b[33m${bar} ${used}%\x1b[0m \x1b[2m${win}\x1b[0m`;
    else if (used < 80) ctx = ` \x1b[38;5;208m${bar} ${used}%\x1b[0m \x1b[2m${win}\x1b[0m`;
    else ctx = ` \x1b[5;31m💀 ${bar} ${used}%\x1b[0m \x1b[2m${win}\x1b[0m`;
  }

  return `\x1b[2m${model}\x1b[0m │ \x1b[2m${dir}\x1b[0m${ctx}${pin}`;
}

// Drop the snapshot next to this script, one file per session (see usageSnapshot).
// Never throws: this runs inside Claude's statusline, and a write failure must cost
// the user a missing /usage answer, not an error line across their terminal.
const USAGE_DIR = 'usage';

function writeUsage(snap) {
  try {
    const s = snap && snap.session;
    if (!s || /[/\\]|\.\./.test(s)) return;                  // same guard as readPin
    if (!snap.ctx && !snap.five && !snap.seven) return;       // nothing worth a file
    const dir = path.join(__dirname, USAGE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, s + '.json'), JSON.stringify(snap));
  } catch (_) { /* no snapshot this time — the line still renders */ }
}

function main() {
  let input = '';
  const timeout = setTimeout(() => process.exit(0), 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', () => {
    clearTimeout(timeout);
    try {
      const data = JSON.parse(input);
      const nowSec = Math.floor(Date.now() / 1000);
      // Снимок расхода пишем ДО чужой строки: он и есть то, ради чего этот скрипт обязан
      // отработать до конца — из него живут полоска на карточке, /usage в телеге и порог
      // перезапуска. Чужая команда после него не может отнять у приложения ничего.
      writeUsage(usageSnapshot(data, nowSec, configRoot(data, process.env)));
      process.stdout.write(composeLine(renderLine(data, nowSec), readForeign(data, input)));
    } catch (_) {
      // Bad/empty stdin must never make Claude show an error line — print nothing.
    }
  });
}

// Only read stdin when actually run as the statusline; the tests require this file.
if (require.main === module) main();

module.exports = {
  renderLine, usedPct, fmtEta, ctxUsed, fmtTok, usageSnapshot, usageReport, USAGE_DIR,
  configRoot, settingsLayers, foreignCommandFrom, isOwnCommand, composeLine, readForeign,
};
