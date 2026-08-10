'use strict';
// Reading the status off Claude's OWN transcript — the third channel, next to screen
// scraping (screen.js) and hooks (osc.js). Claude Code appends every message to
// ~/.claude/projects/<slug>/<session-id>.jsonl as it happens, so the file tells us
// what the agent is doing without a single spawned process per tool call and without
// guessing from pixels:
//
//   last entry is assistant/tool_use   → a tool is running        → работает
//   last entry is user/tool_result     → the model is thinking    → работает
//   last entry is a user prompt        → you just sent something  → работает
//   last entry is assistant text, quiet→ the turn ended           → готов / ждёт
//
// What it CANNOT see is UI state: a permission dialog on screen looks exactly like a
// long-running tool (an open tool_use with no result yet). That stays with the
// PermissionRequest hook / the prompt box on screen.
//
// This module is pure — it takes already-read text and returns a verdict, so it's
// unit-testable on fixtures. The file I/O and the tab↔file matching live in main.js.

// Claude Code's folder name for a project: the absolute path with every separator
// (and dot) flattened to '-'. We don't rely on this being exact — main.js verifies a
// candidate file by the `cwd` recorded INSIDE it — but it gets us to the right
// directory on the first try.
//
// The colon is in the class for Windows: a path starts with a drive (`C:\Users\me`), and
// ':' is illegal in a folder name, so Claude flattens it like everything else —
// `C--Users-me`. Miss it and every Windows path lands one folder off, which means the
// transcript channel silently never finds a file there.
function projectSlug(cwd) {
  return String(cwd || '').replace(/[/\\.:]/g, '-');
}

// Обратная дорога: по адресу стенограммы — КОНФИГ, в котором она лежит. Адрес выглядит как
// <корень>/projects/<слаг>/<id>.jsonl, и корень там не обязательно ~/.claude: `CLAUDE_CONFIG_DIR`
// уводит Клода в другой конфиг целиком (у человека это алиасы `claude-my`, `claude-my2`).
// Приложение раньше складывало путь из зашитого ~/.claude и файла такой вкладки не находило
// НИКОГДА: в телегу вместо ответа агента уезжал соскоб с картинки терминала, а при перезапуске
// вкладка открывалась пустой, потому что её разговор считался мёртвым. Адрес сообщает сам
// Клод (хук), а корень виден из адреса — угадывать больше нечего.
//
// Пустая строка, если это не похоже на путь стенограммы: тогда зовущий остаётся с ~/.claude.
function homeOfTranscript(file) {
  const norm = String(file == null ? '' : file).replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = norm.split('/');
  if (parts.length < 3) return '';
  if (parts[parts.length - 2] === 'projects') return '';   // файл лежит прямо в projects
  if (parts[parts.length - 3] !== 'projects') return '';
  return parts.slice(0, -3).join('/');
}

// Lines that are conversation; everything else in the file (mode, permission-mode,
// ai-title, last-prompt, file-history-*) is bookkeeping we skip.
const MSG_TYPES = new Set(['assistant', 'user']);

// Parse the tail of a .jsonl into conversation entries, newest last. Broken lines are
// skipped: the tail read can start mid-line, and the file may be written as we read.
function parseEntries(text) {
  const out = [];
  for (const line of String(text == null ? '' : text).split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let d;
    try { d = JSON.parse(t); } catch (_) { continue; }
    if (!d || !MSG_TYPES.has(d.type)) continue;
    out.push(d);
  }
  return out;
}

// The content blocks of an entry, as a list of types ('text' | 'thinking' |
// 'tool_use' | 'tool_result'). A string content counts as one text block.
function blockTypes(entry) {
  const c = entry && entry.message && entry.message.content;
  if (typeof c === 'string') return ['text'];
  if (!Array.isArray(c)) return [];
  return c.map((b) => (b && b.type) || '');
}

// The plain text of an entry (all text blocks joined) — this is what the call phrases
// are matched against. Thinking blocks are NOT included: the user never sees them.
function entryText(entry) {
  const c = entry && entry.message && entry.message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text).join('\n');
}

// Ты оборвал агента на полуслове (Esc). Claude Code дописывает в стенограмму запись
// `user` с единственным текстовым блоком «[Request interrupted by user]» — а если рубили
// на инструменте, то «…for tool use]». Больше в файл не приходит НИЧЕГО: ход кончился,
// следующая запись появится только когда ты сам что-нибудь скажешь.
//
// По форме это реплика человека, и без этой проверки classify отвечает «работает
// (prompt)» — «сейчас начнёт работать». Начинать нечего, поэтому вкладка залипала на
// «работает» навсегда: ни отстоя, ни новых записей, чтобы её оттуда вывести. В телеге то
// же самое — оборванная вкладка не докладывала «готов» и висела занятой.
//
// Хук Stop тут не спасает: на прерывании он не срабатывает вообще (это не конец хода, а
// его отмена), так что канал стенограммы — единственный, кто про это знает.
const RE_INTERRUPTED = /^\[Request interrupted by user(?: for tool use)?\]$/;

function isInterrupt(entry) {
  return !!entry && entry.type === 'user' && RE_INTERRUPTED.test(entryText(entry).trim());
}

function tsOf(entry) {
  const t = Date.parse((entry && entry.timestamp) || '');
  return Number.isFinite(t) ? t : 0;
}

// The last entry of the MAIN thread. Sub-agent lines (isSidechain) interleave with it
// and must not drive the tab's status — a sub-agent finishing is not the turn ending.
function lastMain(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!entries[i].isSidechain) return entries[i];
  }
  return null;
}

// Стенограмма описывает ПРОШЛУЮ жизнь вкладки: её последняя запись старше момента, с
// которого эта вкладка живёт. Такому файлу верить нельзя, и вот почему это не мелочь.
//
// Вкладка поднимает разговор через `--resume`. Если тот оборвался на полуслове (последним
// словом был промпт человека, ответить агент не успел — приложение закрыли), classify
// честно читает это как «работает»: последнее слово чужое, значит агент думает. Только
// дописывать оборванный ход уже некому, и вкладка висит жёлтой вечно.
//
// Сравниваем именно записи РАЗГОВОРА, а не mtime файла: при `--resume` Claude дописывает
// туда служебные строки (permission-mode), так что файл выглядит только что тронутым даже
// у разговора, который никто не ведёт.
function isPastLife(entries, startedAt) {
  const at = tsOf(lastMain(Array.isArray(entries) ? entries : []));
  return !!at && !!startedAt && at < startedAt;
}

// How long after the last assistant text we still say «работает». Claude routinely
// writes a paragraph and then keeps going (another tool, more text), so calling
// «готов» on the first quiet tick would flap. This is the only timer here, and it's
// over structured events, not over bytes on screen.
const READY_DEBOUNCE_MS = 1200;

// The verdict. `asks(text)` reads a finished turn's own words (the user's call phrases —
// see ask-phrases.js); pass a function so this module stays free of that config. It
// answers with 'ask' (the agent needs you), 'wait' (it needs nothing but keeps working —
// a background task will wake it), or nothing. A plain `true` still means 'ask', so an
// older caller keeps working. Returns null when the transcript says nothing yet.
//   { status, kind, why, at, text, bg? }
function classify(entries, now, asks) {
  const e = lastMain(entries);
  if (!e) return null;
  const at = tsOf(e);
  const kinds = blockTypes(e);

  if (kinds.includes('tool_use')) {
    // A tool was requested. It's either running, or sitting behind a permission
    // dialog — the transcript can't tell those apart, both are «not your turn yet».
    return { status: 'running', kind: null, why: 'tool_use', at, text: '' };
  }
  if (kinds.includes('tool_result')) {
    return { status: 'running', kind: null, why: 'tool_result', at, text: '' };
  }
  if (e.type === 'user') {
    // Прерывание — конец хода, а не начало работы (см. isInterrupt). Без отстоя: ждать
    // продолжения нечего, оно уже отменено.
    if (isInterrupt(e)) {
      return { status: 'ready', kind: null, why: 'interrupted', at, text: '' };
    }
    // A real prompt from you (not a tool result) — the agent is about to work.
    return { status: 'running', kind: null, why: 'prompt', at, text: '' };
  }
  // An assistant message with only text/thinking: the turn MAY have ended.
  const text = entryText(e);
  if (now - at < READY_DEBOUNCE_MS) {
    return { status: 'running', kind: null, why: 'text (fresh)', at, text };
  }
  const call = typeof asks === 'function' ? asks(text) : null;
  // «Сейчас от тебя: ничего, жду замер стенда» — ход кончился, работа нет. Для стенограммы
  // это неотличимо от «всё сделал»: последняя запись в обоих случаях — тихий текст агента.
  // Знает только он сам, поэтому и решает его фраза. Статус «работает»: отвечать нечего,
  // но и задачу вкладке давать рано — фон её разбудит.
  if (call === 'wait') {
    return { status: 'running', kind: null, why: 'text + wait phrase', at, text, bg: true };
  }
  if (call) {
    return { status: 'waiting', kind: 'question', why: 'text + call phrase', at, text };
  }
  return { status: 'ready', kind: null, why: 'text (quiet)', at, text };
}

// ВЕСЬ текст хода, а не только последнее сообщение агента.
//
// Ход у Клода почти всегда разорван инструментами: «Сейчас посмотрю, что в сборке» →
// Bash → Read → «Нашёл: тесты падали из-за …, починил». В стенограмме это ОТДЕЛЬНЫЕ записи,
// и `classify` возвращает текст лишь последней из них. В телегу поэтому уезжал огрызок —
// финальная фраза без того, что агент рассказал по дороге, — а человек с телефона читает
// ход один раз и другого источника у него нет.
//
// Границей хода служит реплика человека. Результат инструмента приходит записью того же
// типа `user`, и принять его за границу — значит снова обрезать ход по первому же
// инструменту, то есть вернуть ровно ту ошибку, из-за которой эта функция появилась.
//
// `max` — сколько символов имеет смысл отправлять. Набираем С КОНЦА: если ход не влезает,
// выпадает раннее повествование, а вывод — то, ради чего всё и читают, — остаётся целиком.
// Что-то выпало — говорим об этом многоточием, а не молча.
function turnText(entries, max) {
  const list = Array.isArray(entries) ? entries : [];
  const limit = Number(max) > 0 ? Number(max) : Infinity;
  const parts = [];
  let len = 0;
  let cut = false;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (!e || e.isSidechain) continue;
    if (e.type === 'user') {
      if (blockTypes(e).includes('tool_result')) continue;   // не реплика, а ответ инструмента
      // Прерывание тоже не реплика: человек ничего не сказал, он нажал Esc. Границей хода
      // его считать нельзя — иначе у оборванного хода текста нет вообще, и мост докладывает
      // «готов» ни с чем, хотя агент до Esc успел рассказать самое интересное.
      if (isInterrupt(e)) continue;
      break;                                                 // выше — прошлые ходы, они не наши
    }
    const t = entryText(e).trim();
    if (!t) continue;
    // Первое (то есть последнее по времени) сообщение длиннее лимита — режем его с начала:
    // читают сверху вниз, и голову терять хуже, чем хвост.
    if (!parts.length && t.length > limit) return t.slice(0, limit - 1).trimEnd() + '…';
    const add = len ? t.length + 2 : t.length;
    if (len + add > limit) { cut = true; break; }
    parts.push(t);
    len += add;
  }
  const body = parts.reverse().join('\n\n');
  return cut && body ? '…\n\n' + body : body;
}

// --- признаки жизни во время хода ---------------------------------------------
// «Получил, думаю…» в чате может висеть десять минут, и по нему не отличить думающего
// агента от уснувшего мака. Отличают эти две функции: обе читают уже разобранные записи,
// то есть стоят ровно ноль дополнительной работы.

// Чем агент занят ПРЯМО СЕЙЧАС. Открытый tool_use (результат ещё не пришёл) — это имя
// работающего инструмента; всё остальное значит «думает сам», и имени у этого нет.
function currentTool(entries) {
  const e = lastMain(Array.isArray(entries) ? entries : []);
  const c = e && e.message && e.message.content;
  if (!Array.isArray(c)) return null;
  for (let i = c.length - 1; i >= 0; i--) {
    if (c[i] && c[i].type === 'tool_use' && c[i].name) return String(c[i].name);
  }
  return null;
}

// Токены ЭТОГО хода. Claude Code записывает расход в каждое своё сообщение (message.usage),
// так что складывать нужно только записи после последней реплики человека — граница та же,
// что у turnText, и по той же причине: результат инструмента репликой не является.
//
//   out — сколько агент написал. Это число растёт на глазах, пока он говорит, и именно оно
//         отвечает на «он жив?».
//   inp — сколько прочитал: свежий ввод плюс кэш. Больше out в сотни раз, поэтому и
//         показывается отдельно, а не в общей сумме, которую нечем истолковать.
function turnTokens(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let out = 0;
  let inp = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (!e || e.isSidechain) continue;
    if (e.type === 'user') {
      if (blockTypes(e).includes('tool_result')) continue;
      if (isInterrupt(e)) continue;
      break;
    }
    const u = e.message && e.message.usage;
    if (!u) continue;
    out += Number(u.output_tokens) || 0;
    inp += (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0)
      + (Number(u.cache_read_input_tokens) || 0);
  }
  return { out, inp };
}

// Текст, взятый из стенограммы, — про ЭТОТ ход или про прошлый?
//
// Вопрос не праздный: статус «готов» и текст хода приходят по разным каналам и с разной
// задержкой. Хук Stop прилетает сразу по окончании хода, а classify держит «работает» ещё
// READY_DEBOUNCE_MS и до конца отстоя текст не обновляет. То есть в момент, когда мост решает
// докладывать, свежего текста ещё нет — а несвежий есть, и он выглядит совершенно нормально.
// Отправить его в чат значит ответить не на ту задачу, и заметить это невозможно ничем.
//
// Поэтому сравнение по времени: запись, из которой взят текст, должна быть НЕ РАНЬШЕ начала
// хода. Направление сравнения здесь и есть вся суть, поэтому оно живёт отдельной функцией
// с тестом, а не строчкой внутри моста.
function belongsToTurn(textAt, turnStartedAt) {
  return (Number(textAt) || 0) >= (Number(turnStartedAt) || 0);
}

// The cwd a transcript belongs to, from the newest entry that records one. Used to
// bind a file to the right tab instead of trusting the folder-name slug.
function cwdOf(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].cwd) return entries[i].cwd;
  }
  return null;
}

// Tabs whose Claude session id we know bind by file name. This is for the others (a
// resumed tab with hooks off, `claude` typed by hand): pick the file among candidates
// main already read off disk — `{ file, mtimeMs, cwdInside }`.
//
// A candidate must have been written since the tab opened (an older file belongs to a
// past session) and record the same cwd inside. And if TWO survive that, we bind
// NOTHING: driving a tab off another agent's transcript is far worse than falling back
// to the screen scraper. Pure, so that rule is pinned by a test.
const BIND_MTIME_SLACK_MS = 2000;   // clock/fs jitter around the tab's own start

function pickBinding(cands, opts) {
  const o = opts || {};
  const taken = o.taken || new Set();
  const hits = [];
  for (const c of Array.isArray(cands) ? cands : []) {
    if (!c || !c.file || taken.has(c.file)) continue;
    if (!(c.mtimeMs >= (o.startedAt || 0) - BIND_MTIME_SLACK_MS)) continue;
    if (c.cwdInside !== o.cwd) continue;
    hits.push(c.file);
    if (hits.length > 1) return null;
  }
  return hits[0] || null;
}

// Самый надёжный ключ, если вкладку ведут из телеги: мост ЗНАЕТ, что он напечатал. Его
// текст уходит в стенограмму как реплика пользователя с меткой [тлг], которой больше нигде
// нет. Поэтому файл, в котором она лежит, — это файл этой вкладки, и никакие догадки по
// свежести и экрану тут не нужны.
//
// Понадобилось после живого случая: три вкладки на одной папке, все разговоры свежие, ни
// один не выиграл по однозначности — и вкладка осталась без стенограммы, а в телегу уехало
// «✅ готов» без текста ответа.
// Короче этого совпадение ничего не доказывает. Наружу — чтобы мост не запоминал в качестве
// ключа то, что заведомо не сработает (номер варианта из кнопки разрешения).
const INJECTED_MIN = 12;

function pickByInjected(cands, needle) {
  const key = String(needle == null ? '' : needle).trim();
  if (key.length < INJECTED_MIN) return null;
  const hits = [];
  for (const c of Array.isArray(cands) ? cands : []) {
    if (c && String(c.userText || '').includes(key)) hits.push(c.file);
    if (hits.length > 1) return null;        // невозможно, но пусть будет как везде
  }
  return hits[0] || null;
}

// Several transcripts in one folder is the NORMAL case — that's what a swarm looks like:
// three tabs open on the same repo. Refusing to bind any of them (see pickBinding) leaves
// those tabs on screen-scraping, which is exactly the quality we're trying to leave behind.
//
// So break the tie by content: whatever the agent last said is BOTH in its transcript and
// on its own screen. Compare with all whitespace and punctuation stripped, because the
// terminal wraps lines wherever it likes and the same sentence is shaped differently in
// the two places. Only a UNIQUE match counts — a tie here still means «don't bind».
//
// 40 letters is the floor for a comparison to mean anything. Higher (60 was the first
// guess) and an ordinary one-line answer — «Починил сборку, тесты зелёные…» — falls under
// the bar and the tab stays unbound for no good reason; two DIFFERENT conversations
// agreeing on 40 letters running is not a thing, and if they literally do, the
// two-matches guard below refuses anyway.
const SCREEN_KEY_LEN = 40;

function screenKey(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function pickByScreen(cands, snapshot) {
  const hay = screenKey(snapshot);
  if (hay.length < SCREEN_KEY_LEN) return null;      // too little on screen to be sure
  let hit = null;
  for (const c of Array.isArray(cands) ? cands : []) {
    if (!c || !c.file) continue;
    const key = screenKey(c.text);
    if (key.length < SCREEN_KEY_LEN) continue;       // and too little in the transcript
    if (!hay.includes(key.slice(-SCREEN_KEY_LEN))) continue;
    if (hit) return null;                            // two transcripts match: no guessing
    hit = c.file;
  }
  return hit;
}

module.exports = {
  READY_DEBOUNCE_MS, BIND_MTIME_SLACK_MS, SCREEN_KEY_LEN, INJECTED_MIN, screenKey, pickByScreen,
  projectSlug, homeOfTranscript, parseEntries, blockTypes, entryText, lastMain, tsOf, isPastLife, classify, cwdOf, pickBinding, isInterrupt,
  belongsToTurn, turnText, currentTool, turnTokens,
  pickByInjected,
};
