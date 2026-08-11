'use strict';
// Pure screen-scraping helpers for the status detector. Kept out of main.js so
// they're unit-testable in plain node, like git.js / updater-core.js.

const { DEFAULT_ASK_PHRASES, buildAskMatcher, asksWith, waitsWith } = require('./ask-phrases');

// --- the snapshot window ------------------------------------------------------
// What the detector actually looks at: the bottom rows of the emulator. The window
// must be anchored to the last row that HAS content, never to buf.length.
//
// Claude Code's UI is a TUI frame that grows and shrinks (spinner block, permission
// box, a multi-line input collapsing after submit). Shrinking is drawn as "cursor up
// N rows + erase to end of screen" — the rows the tall frame had scrolled into the
// buffer stay allocated, just blank, and buf.length NEVER shrinks. A window anchored
// to buf.length then slides off the real screen into that emptiness, so every marker
// (prompt box, spinner, «Сейчас от тебя») reads as absent and the tab paints a false
// «готов» while a question sits visible on screen.

// The row after the last one with content (an exclusive end index).
function contentEnd(buf) {
  let end = buf.length;
  while (end > 0) {
    const line = buf.getLine(end - 1);
    const text = line ? line.translateToString(true) : '';
    if (text.trim()) break;
    end--;
  }
  return end;
}

// The bottom `rows` rows of the screen that carry content, as one string.
function snapshotRows(buf, rows) {
  const end = contentEnd(buf);
  const start = Math.max(0, end - rows);
  const out = [];
  for (let y = start; y < end; y++) {
    const line = buf.getLine(y);
    if (line) out.push(line.translateToString(true));
  }
  return out.join('\n');
}

// Тот же снимок, но перенесённые строки склеены обратно в одну — для ТЕКСТА ответа, а не
// для статуса.
//
// Терминал ломает абзац по ширине окна, и каждый обрывок ложится отдельным рядом. Для
// детектора это неважно (он ищет маркеры), а в чат из-за этого уезжала лестница: перевод
// строки посреди слова там, где агент писал сплошной абзац. Ширина окна — свойство того, кто
// смотрит, и в ответе её быть не должно.
//
// Ряд-продолжение эмулятор помечает сам (isWrapped), и это единственный надёжный признак:
// по длине строки перенос от настоящего перевода строки не отличить. Ряд, у которого есть
// продолжение, дописан до края — обрезать ему хвост нельзя, иначе на стыке пропадёт пробел
// и два слова срастутся.
function snapshotWrapped(buf, rows) {
  const end = contentEnd(buf);
  const start = Math.max(0, end - rows);
  const out = [];
  for (let y = start; y < end; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const next = y + 1 < end ? buf.getLine(y + 1) : null;
    const text = line.translateToString(!(next && next.isWrapped));
    if (line.isWrapped && out.length) out[out.length - 1] += text;
    else out.push(text);
  }
  return out.join('\n');
}

// Строка статуса Клода (model │ dir [полоска] % │ задача) рисуется самым нижним рядом.
// Берём нижний ряд, похожий на неё (есть разделители │ или блоки полоски), — из него
// приложение показывает подпись на карточке и полоску контекста.
//
// Найденный ряд ДОБИРАЕМ В ОБЕ СТОРОНЫ по пометке isWrapped. С тех пор как наша строка
// печатается вместе со строкой человека (swarm-statusline.js, readForeign), она стала вдвое
// длиннее и в узком окне переносится, а ряды эмулятор хранит порознь. Обе половины опасны
// поодиночке, и обе встречаются: разделитель │ может остаться и в голове, и в хвосте —
// смотря где ляжет перенос. Хвост сам по себе — это ЧУЖАЯ строка вместо нашей: полоска
// нарисуется по первому проценту в ней, а на этом же проценте стоит решение о перезапуске
// по контексту. Голова сама по себе — обрезанная наша, без чужого куска вовсе.
function statuslineOf(buf, rows) {
  const end = contentEnd(buf);   // тот же якорь, что у snapshot(): пустой хвост врёт
  const start = Math.max(0, end - rows);
  for (let y = end - 1; y >= start; y--) {
    const line = buf.getLine(y);
    if (!line) continue;
    const t = line.translateToString(true).trim();
    if (!t.includes('│') && !/[█░]/.test(t)) continue;
    let top = y;
    while (top > start && buf.getLine(top) && buf.getLine(top).isWrapped) top--;
    let bottom = y;
    while (bottom + 1 < end && buf.getLine(bottom + 1) && buf.getLine(bottom + 1).isWrapped) bottom++;
    // Склеиваем как snapshotWrapped: у ряда, за которым идёт продолжение, хвост обрезать
    // нельзя, иначе на стыке пропадёт пробел и два слова срастутся.
    let whole = '';
    for (let i = top; i <= bottom; i++) {
      const l = buf.getLine(i);
      if (!l) continue;
      const next = i + 1 <= bottom ? buf.getLine(i + 1) : null;
      whole += l.translateToString(!(next && next.isWrapped));
    }
    return whole.trim() || t;
  }

  return '';
}

// A selection row before the answer: "❯ 1. Yes". Claude Code paints ❯, but
// Cursor / some terminals use an arrow (→ ▸ ▶) or a plain ">".
const OPTION_RE = /^\s*[❯>→➜▸►▶]?\s*\d+\.\s/;
// Подсказки под диалогом. «Tab to amend» — из живого Claude Code 2.1.220; без неё строка
// подсказки уезжала в текст кнопки как часть вопроса.
const HINT_RE = /Esc to cancel|Enter to confirm|Tab to amend/i;
// Claude Code's own furniture around the input box: the mode line, the shortcut hints,
// the context meter. It sits BELOW the agent's prose, so a bottom-up scan hits it first
// and would happily quote «⏵⏵ auto mode on (shift+tab to cycle) · ← for agents» to the
// user as if that were the question. It's chrome, never a sentence anyone wrote.
// Подсказки, которые Claude Code рисует ПОД ответом, добавлены по живым случаям: в чат
// уезжало «Jump to bottom (click) ↓» и «new task? /clear to save 141.5k tokens» — это
// мебель, а человек с телефона читал её как ответ агента. Кружок ◯ — строка ростера
// подагентов («◯ review-synth Checking …»), туда же.
const CHROME_RE = new RegExp([
  'shift\\+tab', 'ctrl\\+[a-z]', 'esc to ', ' for shortcuts', ' for agents',
  '(?:auto|plan|accept edits|bypass permissions|bypassing permissions) mode on',
  'auto-compact', 'context left until', 'tokens? (?:used|remaining)',
  'jump to bottom', '/clear to save', '^new task\\?',
  // ● — не только ростер: Claude Code 2.1.220 рисует им строку усилия («● high · /effort»),
  // а имя сессии, которым её назвал сворм («swarm-f81789c0 …»), стоит там же. Обе уехали в
  // телегу как «ответ агента» на вкладке, у которой ещё не привязалась стенограмма.
  '^[⏵⏸⧉⎿✻✽✶✳·◯○◌●]', '^swarm-[0-9a-f]{6,}\\b',
].join('|'), 'i');
// After edge trimming, a leftover │ or a progress bar means we're looking at the
// user's Claude statusline ("model │ dir │ ███░ 65%"), not at a question.
const STATUSLINE_RE = /[│┃█░]/;
const HAS_TEXT_RE = /[\p{L}\p{N}]/u;
// Строка, которую можно ПОКАЗАТЬ человеку как вопрос, обязана содержать букву — и это
// строже, чем «в ней есть текст». Линейка с числом внутри («──── 3 ────», «════ 45% ════»)
// цифрой проходит проверку на текст и уезжает в уведомление целиком. Причём выглядит это
// не как линейка с числом, а как полоска: в уведомление влезает 140 символов, и на широком
// терминале число стоит правее обрезки. Поэтому — буква, иначе это мебель.
const HAS_LETTER_RE = /\p{L}/u;
// Линейки по краям: заголовок в рамке приходит как «─ Plan ───────», и в кнопку/уведомление
// такое писать нельзя. Снимаем только рисованные линейки: ASCII `-` и `_` в прозе обычны,
// а тире «—» (U+2014) — это знак препинания, не линейка.
const RULE_EDGE_RE = /^[\s─━═╌╍┄┅┈┉]+|[\s─━═╌╍┄┅┈┉]+$/g;
const MAX = 80;

// Строка без обрамляющих линеек. Отдельно от clean(), потому что clean общий: parsePrompt
// ловит сплошную линейку как границу запроса, и снять её там значило бы потерять границу.
function unrule(t) {
  return String(t).replace(RULE_EDGE_RE, '').trim();
}

// Strip the box drawing that frames a prompt, then normalise spacing. Edges
// only: an inner │ is the statusline tell, so it must survive this.
function clean(line) {
  return String(line)
    .replace(/^[\s│┃┌└├╭╰]+/, '')
    .replace(/[\s│┃┐┘┤╮╯]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Режим разрешений, как его показывает сам Claude Code в строке под полем ввода:
// «⏸ manual mode on», «⏵⏵ accept edits on», «⏸ plan mode on». Нужен для управления
// режимом из телеги: жать shift+tab вслепую нельзя — надо видеть, куда попали.
//
// Порядок проверок важен: строка про accept edits тоже содержит слово mode, а плановый
// режим в разных сборках подписан то «plan mode», то «⏸ plan».
const MODE_RULES = [
  [/bypass(?:ing)?\s+permissions/i, 'bypass'],
  [/accept\s+edits/i, 'accept-edits'],
  [/plan\s+mode/i, 'plan'],
  [/\b(?:manual|normal|default)\s+mode/i, 'manual'],
  [/\bauto\s+mode/i, 'auto'],
];
// Живой круг Shift+Tab в Claude Code 2.1.220 (снят с TUI, см. тесты):
//   manual → accept edits → plan → auto → manual …
// Четыре режима, и «auto» — НЕ синоним «accept edits»: правки без спроса разрешают только
// правки, а auto судит каждое действие само. Путать их нельзя: это разная цена.
//
// И «auto» — НЕ «без вопросов совсем». У него в 2.1.220 свой классификатор
// (`claude auto-mode defaults`): 17 разрешающих правил и 65 категорий, на которых он всё
// равно спросит, — разрушительный git, необратимое удаление, деплой в прод, секреты,
// ослабление TLS, публикация наружу. Подписи это учитывают: обещать тишину, которой не
// будет, — та же ложь про цену, только в обратную сторону, и человек решает, что режим не
// переключился, когда запрос всё-таки приходит. Настоящая тишина — это bypass.
const MODE_TITLES = {
  manual: 'обычный — спрашивает разрешение',
  'accept-edits': 'правки без спроса — остальное спрашивает',
  plan: 'планирование — сначала план, без изменений',
  auto: 'авто — сам решает, спрашивает только на опасном',
  bypass: 'без спроса совсем (bypass permissions)',
};

// Как тот же режим называется во ФЛАГЕ Claude Code: `--permission-mode <mode>`. Наши имена
// не совпадают с его написанием (у нас «accept-edits», у него «acceptEdits»), а расхождение
// здесь — это вкладка, которая не стартует вовсе: неизвестное значение флага claude не
// проглатывает, он отказывается запускаться. Поэтому соответствие живёт рядом с самими
// режимами и закреплено тестом.
const MODE_FLAGS = {
  manual: 'manual',
  'accept-edits': 'acceptEdits',
  plan: 'plan',
  auto: 'auto',
  bypass: 'bypassPermissions',
};

function modeFlag(id) {
  return MODE_FLAGS[id] || null;
}

function readMode(snapshot) {
  const lines = String(snapshot == null ? '' : snapshot).split('\n');
  // Снизу вверх: строка режима — часть мебели под полем ввода, а выше в прозе агента
  // слова «plan mode» могут встретиться просто по смыслу.
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = clean(lines[i]);
    if (!t || !CHROME_RE.test(t)) continue;      // строка режима — это мебель
    for (const [re, id] of MODE_RULES) if (re.test(t)) return id;
  }
  return null;
}

function modeTitle(id) {
  return MODE_TITLES[id] || String(id || 'неизвестный');
}

// Что агент сказал ПОСЛЕДНИМ — для отчёта в телегу, когда стенограмма не привязана.
//
// Отдельная функция, а не extractQuestion: та возвращает нижнюю значимую строку, а внизу у
// Claude Code стоит ПОЛЕ ВВОДА с текстом человека. Из-за этого в чат уезжало то линейка
// рамки, то собственный вопрос пользователя, отражённый ему же как «ответ агента». Поэтому
// строки поля ввода и прозы человека (начинаются с ❯) пропускаются наравне с мебелью.
//
// Реплики человека Claude Code оставляет в переписке как «> текст» — то есть отправленный
// ответ никуда с экрана не девается и лежит НИЖЕ вопроса, на который отвечал. Поэтому этот
// же образец обязателен и там, где строку показывают человеку как вопрос (extractQuestion):
// иначе уведомление приходит с его собственным ответом.
const USER_LINE_RE = /^[❯>»]\s*\S/;
const AGENT_BULLET_RE = /^[⏺]\s*/;

function lastAgentLine(snapshot) {
  const lines = String(snapshot == null ? '' : snapshot).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = unrule(clean(lines[i]));
    if (!t || !HAS_LETTER_RE.test(t)) continue; // рамки, линейки (в т.ч. с числом), пустое поле
    if (STATUSLINE_RE.test(t)) continue;        // статуслайн пользователя
    if (OPTION_RE.test(t)) continue;            // «❯ 1. Yes»
    if (HINT_RE.test(t)) continue;              // «Esc to cancel»
    if (CHROME_RE.test(t)) continue;            // «⏸ manual mode on», «✻ Churned for 7s»
    if (USER_LINE_RE.test(t)) continue;         // поле ввода и реплики человека
    const s = t.replace(AGENT_BULLET_RE, '');
    if (!s || !HAS_LETTER_RE.test(s)) continue;
    return s.length > MAX ? s.slice(0, MAX - 1).trimEnd() + '…' : s;
  }
  return null;
}

// Весь последний ответ агента с экрана — для отчёта в телегу, когда стенограммы нет.
//
// lastAgentLine отдаёт ОДНУ строку и не длиннее 80 символов: этого хватает подписи на
// плашке, но в чат уезжал огрызок — последняя строка абзаца, а то и подсказка из мебели.
// Здесь собирается сообщение целиком: снизу вверх, начиная с первой строки прозы под
// мебелью и до начала сообщения.
//
// Границы сверху — то, что сообщением быть не может: собственный маркер ⏺ (это и есть
// начало ответа, его забираем и останавливаемся), реплика человека, блок инструмента,
// рамка, статуслайн, мебель. Пустые строки внутри сохраняем: у Клода это абзацы, а
// оборвать сбор на первой пустой строке значило бы прислать один последний абзац.
const BLOCK_LINES = 200;      // предохранитель: не собирать пол-переписки, если границы нет
const BLOCK_GAP = 2;          // столько пустых строк подряд ещё считаем абзацем, дальше — граница

// Строка, которую можно показать человеку как речь агента (а не как мебель Claude Code).
function isProse(t) {
  if (!t || !HAS_LETTER_RE.test(t)) return false;
  return !STATUSLINE_RE.test(t) && !OPTION_RE.test(t) && !HINT_RE.test(t)
    && !CHROME_RE.test(t) && !USER_LINE_RE.test(t);
}

function lastAgentBlock(snapshot, max) {
  const lines = String(snapshot == null ? '' : snapshot).split('\n');
  const limit = Number(max) > 0 ? Number(max) : Infinity;
  const out = [];
  let started = false;
  let blanks = 0;
  for (let i = lines.length - 1; i >= 0 && out.length < BLOCK_LINES; i--) {
    const t = unrule(clean(lines[i]));
    if (!started) {
      if (!isProse(t)) continue;                 // ещё мебель под ответом
      started = true;
    } else if (!t) {
      if (++blanks > BLOCK_GAP) break;           // большой разрыв — это уже не наш абзац
      out.push('');
      continue;
    } else if (!isProse(t)) {
      break;                                     // ⎿, ❯, рамка, статуслайн — начало чужого
    } else {
      blanks = 0;
    }
    const bullet = AGENT_BULLET_RE.test(t);
    const s = t.replace(AGENT_BULLET_RE, '').trim();
    if (s) out.push(s);
    if (bullet) break;                           // ⏺ — начало этого сообщения
  }
  const body = out.reverse().join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!body) return null;
  return body.length > limit ? body.slice(0, limit - 1).trimEnd() + '…' : body;
}

// The one-line gist of what an agent is asking, for the pult chip. Scans bottom
// -up because the live prompt sits at the bottom of the screen. Best effort by
// design: null just means the chip shows the tab name (see the spec).
function extractQuestion(snapshot) {
  const lines = String(snapshot == null ? '' : snapshot).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = unrule(clean(lines[i]));
    if (!t) continue;
    if (!HAS_LETTER_RE.test(t)) continue; // frames, rules (even with a number in them), "> "
    if (STATUSLINE_RE.test(t)) continue;  // the user's statusline
    if (OPTION_RE.test(t)) continue;      // "❯ 1. Yes"
    if (HINT_RE.test(t)) continue;        // "Esc to cancel"
    if (CHROME_RE.test(t)) continue;      // "⏵⏵ auto mode on (shift+tab to cycle)"
    if (USER_LINE_RE.test(t)) continue;   // «> да, гоняй» — это МОЙ ответ, а не вопрос
    return t.length > MAX ? t.slice(0, MAX - 1).trimEnd() + '…' : t;
  }
  return null;
}

// Permission prompts carry phrasing that AskUserQuestion / prose questions never
// do: Claude asks to run a tool or edit ("Do you want to proceed?") and always
// offers the "No, and tell Claude what to do differently" escape. That's the tell.
const PERMISSION_RE = /No, and tell Claude|Do you want\b/i;
// A selection cursor immediately before a numbered option ("❯ 1. …"). Mirrors the
// detector's RE_WAIT_NOW option pattern; used here to spot an AskUserQuestion list.
// Not anchored — we scan the whole snapshot, not one line.
const OPTIONS_RE = /[❯>→➜▸►▶]\s*\d+\.\s/;
// «Сейчас от тебя: …» closes a turn saying what the user must do — but ONLY when it
// actually asks for something. "Сейчас от тебя: ничего, жди результата" is the
// opposite: the agent says nothing is needed. So the marker alone isn't enough —
// if the first word after it is a nothing/wait word, it's NOT a request.
// The phrases are the user's own convention (Settings → Запуск), so they're
// configurable: ask-phrases.js owns the list and compiles the matcher, main pushes
// the saved one in via setAskPhrases. Until then we run on the defaults.
let askMatcher = buildAskMatcher(DEFAULT_ASK_PHRASES);

// Swap in the user's phrases (called by main on startup and on save).
function setAskPhrases(list) {
  askMatcher = buildAskMatcher(list);
}

// True only for a REAL call-me request (a phrase is present, and it isn't a
// «Сейчас от тебя: ничего, жди …»).
function asksForInput(snapshot) {
  return asksWith(askMatcher, snapshot);
}

// Агент закрыл ход, но работа продолжается без человека: «Сейчас от тебя: ничего, жду
// замер стенда». Отвечать нечего, а вкладка при этом занята — фоновая задача досчитает и
// сама разбудит агента. Отдельно от asksForInput, потому что и статус получается третий:
// не «ждёт ответа» и не «готов», а «работает». См. WAIT_TAIL в ask-phrases.js.
function waitsForWork(snapshot) {
  return waitsWith(askMatcher, snapshot);
}

// Отпечаток ЗОВА, как он сейчас нарисован на экране: строки с настоящей просьбой, слитые в
// один короткий хеш.
//
// Нужен потому, что зов прозой — это не диалог, а текст переписки: диалог разрешения Claude
// Code стирает в тот же миг, когда ты ответил, а строка «Сейчас от тебя: …» остаётся висеть
// и после ответа. Отличить «меня зовут» от «я это уже закрыл» по одному факту наличия строки
// нельзя — нужен признак, что зов ИЗМЕНИЛСЯ с момента моего ответа. Считаем по всем строкам
// сразу, а не по первой: повторный точно такой же зов даёт вторую строку, и отпечаток от этого
// меняется — иначе повтор слова в слово выглядел бы как уже отвеченный.
function askFingerprint(snapshot) {
  const hits = [];
  for (const line of String(snapshot == null ? '' : snapshot).split('\n')) {
    const t = clean(line);
    if (t && asksWith(askMatcher, t)) hits.push(t);
  }
  return hits.length ? fingerprintOf(hits.join('|')) : '';
}

// --- the prompt box as data ---------------------------------------------------
// A permission / choice prompt, parsed into something answerable from a phone: WHAT is
// being asked (including the command, when Claude shows one) and the options it offered.
//
// The whole point is that you approve what you SEE: the buttons carry Claude's own
// options, so nothing can be approved that wasn't on the list. The fingerprint is the
// safety catch — the prompt on screen may have changed between us sending the message
// and you tapping a button, and printing «2» into whatever replaced it would be the
// worst thing this bridge could do.
const OPTION_LINE_RE = /^\s*[❯>→➜▸►▶]?\s*(\d+)\.\s+(.*\S)/;
const OPT_TEXT_MAX = 58;   // a Telegram inline button label, not a paragraph
const TITLE_MAX = 300;
// Докуда смотреть вверх от вариантов. Не «сколько строк текста», а докуда вообще имеет смысл
// идти: настоящей границей служит сплошная линейка запроса, а это просто предохранитель,
// чтобы на экране без рамки не собрать в заголовок пол-переписки.
const TITLE_LINES = 14;

// Deterministic, dependency-free hash (djb2) — this only has to detect CHANGE, so a
// short base36 digest is plenty and keeps this module pure.
function fingerprintOf(text) {
  let h = 5381;
  const t = String(text == null ? '' : text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Варианты — это НЕПРЕРЫВНЫЙ блок внутри рамки, а не любые строки «N. текст» на экране.
// Иначе нумерованный список в прозе агента («Предлагаю план: 1. переписать оплату») попадал
// в кнопки, а нажатие печатало «1» в диалог разрешения ниже — то есть кнопка одобряла не то,
// что на ней написано. Отпечаток от этого не защищает: он ловит смену экрана, а не мусор в
// разборе. Поэтому три требования: рамка, непрерывность, нумерация с 1 без дублей.
const FRAME_RE = /[│┃╭╰┌└├]/;
const GAP_MAX = 2;   // внутри бокса между вариантами бывает пустая строка рамки
// А в вопросе с вариантами (AskUserQuestion) под каждым вариантом стоит ЕГО ОПИСАНИЕ, и на
// узком окне описание переносится на две-три строки. Живой экран (снят с Claude Code 2.1.220,
// см. фикстуру QUIZ_REAL в тестах):
//
//   ❯ 1. Светлый
//        Тёмный текст на светлом фоне. Хорошо читается днём.
//     2. Тёмный
//        Светлый текст на тёмном фоне. Меньше устают глаза.
//     4. Type something.
//
// С разрывом в две строки блок рассыпался на одиночные варианты, годного (два и больше)
// не оставалось — и мост отвечал «вариантов не разобрал». А дальше начинался тупик: кнопок с
// вариантами нет, а прозу в открытый диалог мост не печатает, так что с телефона нельзя было
// ни выбрать, ни написать. Поэтому разрыв побольше разрешён — но только если между номерами
// стоят именно ОПИСАНИЯ: строки с отступом ГЛУБЖЕ, чем у самого номера. Прозаический
// нумерованный список в переписке так не выглядит, и защита от него остаётся на месте.
const DESC_GAP_MAX = 5;
// Маркер выбора Ink: он есть в ЛЮБОМ диалоге выбора и не бывает в прозе агента.
const MARKER_RE = /^[❯>→➜▸►▶]\s*\d+\.\s/;
// Линейки в диалоге бывают двух смыслов, и путать их нельзя:
//   сплошная (──── ═══) — ВЕРХНЯЯ ГРАНИЦА запроса, выше неё уже переписка, и на ней разбор
//     заголовка останавливается;
//   пунктирная (╌╌╌╌) — внутренний разделитель вокруг диффа, через него надо ПЕРЕШАГИВАТЬ.
// Своего образца пунктиру не нужно: в нём нет ни букв, ни цифр, поэтому его снимает общая
// проверка «в строке нет текста» (там же, где пустые строки).
const SOLID_RULE_RE = /^[\s─━═]+$/;
// Строка содержимого файла в диффе: «  1 привет», « 12 +const a = 1». Это не заголовок
// запроса, а то, ЧТО меняют — в кнопку такое не пишут.
const DIFF_LINE_RE = /^\s*\d+\s+\S/;
const TITLE_KEEP = 6;      // сколько осмысленных строк над блоком берём в текст запроса
const ANCHOR_BELOW = 3;   // на сколько строк ниже блока искать «Esc to cancel»

// Строка-подсказка под блоком («Esc to cancel · Tab to amend») — признак, что это диалог, а
// не нумерованный список в прозе. Ищем чуть ниже последнего варианта: между ними бывает
// пустая строка.
function hintBelow(lines, from) {
  for (let i = from + 1; i <= from + ANCHOR_BELOW && i < lines.length; i++) {
    if (HINT_RE.test(clean(lines[i]))) return true;
  }
  return false;
}

// Отступ строки: пробелы и вертикаль рамки перед содержимым. Считаем по СЫРОЙ строке — clean()
// отступ как раз и съедает.
function indentOf(line) {
  const m = String(line == null ? '' : line).match(/^[\s│┃╭╰┌└├]*/);
  return m ? m[0].length : 0;
}

// Между двумя вариантами стоит только ОПИСАНИЕ первого из них? Признак один и надёжный:
// описание Клод рисует с отступом глубже, чем номер варианта (см. DESC_GAP_MAX). Сплошная
// линейка описанием быть не может — это граница блока.
function describesOption(lines, from, to) {
  const base = indentOf(lines[from]);
  let seen = false;
  for (let i = from + 1; i < to; i++) {
    const t = clean(lines[i]);
    if (!t) continue;                              // пустая строка внутри блока не помеха
    if (SOLID_RULE_RE.test(t)) return false;
    if (indentOf(lines[i]) <= base) return false;   // не глубже номера — это уже не его текст
    seen = true;
  }
  return seen;
}

function parsePrompt(snapshot) {
  const lines = String(snapshot == null ? '' : snapshot).split('\n');
  // 1. Все кандидаты вместе с сырой строкой: рамку проверяем по ней, до clean().
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const t = clean(lines[i]);
    const m = t.match(OPTION_LINE_RE);
    if (m) {
      hits.push({
        i, n: Number(m[1]), text: m[2],
        framed: FRAME_RE.test(lines[i]),
        marked: MARKER_RE.test(t),
      });
    }
  }
  // 2. Разбиваем на непрерывные блоки.
  const blocks = [];
  for (const h of hits) {
    const last = blocks[blocks.length - 1];
    const prev = last && last[last.length - 1];
    const gap = prev ? h.i - prev.i : Infinity;
    if (prev && (gap <= GAP_MAX
        || (gap <= DESC_GAP_MAX && describesOption(lines, prev.i, h.i)))) last.push(h);
    else blocks.push([h]);
  }
  // 3. Годный блок: минимум два варианта, номера 1..N без повторов и ПРИВЯЗКА к диалогу.
  //    Живой запрос всегда снизу, поэтому берём последний годный.
  //
  //    Привязка — три признака, любой достаточен. Рамки одной мало: Claude Code (2.1.220)
  //    рисует запросы БЕЗ вертикальной рамки, только горизонтальными линейками, и
  //    требование рамки отбраковывало все настоящие диалоги — бот отвечал «вариантов не
  //    разобрал» на каждый запрос разрешения. Проверено на снятых с живого TUI экранах
  //    (см. фикстуры PERM_REAL_* в тестах).
  let block = null;
  for (const b of blocks) {
    if (b.length < 2) continue;
    if (b.some((h, k) => h.n !== k + 1)) continue;
    const anchored = b.some((h) => h.framed || h.marked) || hintBelow(lines, b[b.length - 1].i);
    if (!anchored) continue;
    block = b;
  }
  if (!block) return null;
  const options = block.map((h) => ({
    n: h.n,
    text: h.text.length > OPT_TEXT_MAX ? h.text.slice(0, OPT_TEXT_MAX - 1).trimEnd() + '…' : h.text,
  }));
  // 4. Заголовок — над БЛОКОМ (там «Bash command», сама команда, «Do you want to proceed?»),
  //    а не над первой цифрой на экране. Идём ВВЕРХ и останавливаемся на линейке: в диалоге
  //    правки над вопросом стоит пунктир, а выше него — сам дифф, и без остановки в текст
  //    кнопки уезжали строки файла («1 привет») вместо вопроса.
  const head = [];
  let kept = 0;
  for (let i = block[0].i - 1; i >= 0 && block[0].i - i <= TITLE_LINES; i--) {
    const raw = lines[i];
    const t = clean(raw);
    // Сплошная линейка — верх запроса: выше только переписка, туда не лезем. Проверяем и
    // очищенную строку: у бокса верх выглядит как «╭────╮», и без этого прозаический список
    // «Предлагаю план: 1. …» над запросом попадал бы в текст кнопки.
    if (!HAS_TEXT_RE.test(t) && (SOLID_RULE_RE.test(t) || SOLID_RULE_RE.test(raw))) break;
    // Пустые строки и пунктирные разделители перешагиваем, НЕ тратя на них бюджет: в живом
    // диалоге на команду между «Bash command» и вопросом стоят две пустые строки, и
    // прежний счётчик на пять строк упирался в них — в телегу уезжало одно голое
    // «Do you want to proceed?», без самой команды. Одной проверки хватает на оба случая:
    // в пунктире (╌╌╌ ┄┄┄ ---) нет ни букв, ни цифр, поэтому он отсеивается здесь же.
    if (!t || !HAS_TEXT_RE.test(t)) continue;
    // Линейка с числом внутри («──── 3 ────») цифрой проходит проверку выше, а границей
    // запроса не считается — то есть попала бы в заголовок кнопки как полоска. Заголовок без
    // единой буквы человеку ничего не говорит, поэтому такую строку просто перешагиваем.
    if (!HAS_LETTER_RE.test(t)) continue;
    if (DIFF_LINE_RE.test(t)) continue;         // содержимое файла — не заголовок запроса
    if (STATUSLINE_RE.test(t) || CHROME_RE.test(t) || HINT_RE.test(t)) continue;
    head.unshift(t);
    if (++kept >= TITLE_KEEP) break;
  }
  let title = head.join(' · ');
  if (title.length > TITLE_MAX) title = title.slice(0, TITLE_MAX - 1).trimEnd() + '…';
  return {
    title,
    options,
    fingerprint: fingerprintOf(title + '|' + options.map((o) => o.n + o.text).join('|')),
  };
}

// WHY a waiting agent is calling — for the pult chip, tab sub-label and notify.
// Only sensible once status is already «waiting». Returns:
//   'permission' — a tool/edit approval prompt (act fast: yes/no)
//   'question'   — AskUserQuestion options, a prose "Сейчас от тебя", or any
//                  extractable question line
//   null         — nothing confident to say; caller keeps the generic «ждёт ответа»
// Order matters: permission phrasing must be checked before options, or a
// permission prompt (which also has "❯ 1. Yes") would misread as a question.
function inferWaitingKind(snapshot) {
  const text = String(snapshot == null ? '' : snapshot);
  if (PERMISSION_RE.test(text)) return 'permission';
  if (OPTIONS_RE.test(text)) return 'question';
  if (asksForInput(text)) return 'question';
  if (extractQuestion(text)) return 'question';
  return null;
}

// Sub-agents (Claude Code's Task/agent tool). Claude runs them in the background
// by default and pins a status line just above the input box:
//   "✻ Waiting for N background agents to finish"
// It stays whether the main turn is busy OR the prompt is idle — and the idle case
// is exactly when the byte-flow/spinner heuristic wrongly reads «готов» (green),
// which is the bug this detects. When the roster panel is expanded (↓ to manage)
// each RUNNING agent is a hollow-circle row, while «⏺ main» / finished agents use a
// filled glyph:
//   "◯ Explore  <desc>   2m 2s · ↓ 28.4k tokens"
const RE_AGENTS_WAIT = /Waiting for (\d+) background agents?\b/i;
const RE_AGENT_ROW = /^\s*[◯○]\s/;   // a running sub-agent row (hollow circle)

// How many sub-agents are running per the current screen (0 = none). Prefers the
// explicit "Waiting for N …" count — it's present even when the roster is collapsed
// and it never counts the main thread. Falls back to counting expanded hollow-circle
// roster rows (filled ⏺/● rows — main + finished agents — are deliberately excluded).
function countSubagents(snapshot) {
  const text = String(snapshot == null ? '' : snapshot);
  const m = text.match(RE_AGENTS_WAIT);
  if (m) return parseInt(m[1], 10) || 0;
  let rows = 0;
  for (const line of text.split('\n')) if (RE_AGENT_ROW.test(line)) rows++;
  return rows;
}

// --- экран отлистан назад: этому не верить ------------------------------------
// Прокрутка колесом уходит АГЕНТУ (Claude включает отслеживание мыши и живёт в
// альт-экране, где скроллбека у эмулятора нет). Листая, он перерисовывает экран
// прошлой перепиской — и детектор, который читает именно экран, видит вопрос,
// заданный полчаса назад, и отсутствие спиннера. Отсюда «прокрутил работающую
// вкладку вверх → стала готова и прислала уведомление о старом вопросе».
//
// Отлистанный вид Клод помечает сам — плашкой возврата вниз. Проверено на живом
// claude 2.1.220: плашка ложится ПОВЕРХ строки содержимого, а не отдельной строкой,
// поэтому ищем подстроку, а не строку целиком:
//   "│   ▘▘ ▝▝      Jump to bottom (click) ↓ aude Opus 5 (`claude-opus-5`)… │"
//   "⎿  $ ls -la /Users/evgeniy/WebstormP 1 new message (click) ↓ /node_modules"
// Текст плашки разный: «Jump to bottom» либо «N new message(s)», а хвост зависит от
// терминала и раскладки хоткеев — «(click) ↓», «(ctrl+b) ↓», «: fn+↓ to scroll»,
// в самом узком окне просто «… ↓». Общее у всех — сама фраза и стрелка вниз следом.
//
// Стрелку требуем ОБЯЗАТЕЛЬНО: без неё «Jump to bottom» — обычные английские слова,
// и вкладка замирала бы всякий раз, когда агент печатает их на экране (например
// выводит этот самый файл). Плашка без стрелки остаётся только в окне уже 18 колонок,
// чего не бывает.
const RE_SCROLLED_BACK = /(?:Jump to bottom|\d+ new messages?)[^\n]{0,40}?↓/;

function scrolledBack(snapshot) {
  return RE_SCROLLED_BACK.test(String(snapshot == null ? '' : snapshot));
}

module.exports = {
  extractQuestion, lastAgentLine, lastAgentBlock, readMode, modeTitle, modeFlag, MODE_TITLES, MODE_FLAGS,
  inferWaitingKind, asksForInput, waitsForWork, askFingerprint, setAskPhrases, countSubagents,
  parsePrompt, fingerprintOf, scrolledBack,
  contentEnd, snapshotRows, snapshotWrapped, statuslineOf,
};
