// Plain-node tests for the screen scraping helpers used by the status detector.
const assert = require('assert');
const S = require('../screen');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// A permission prompt as Claude Code paints it: framed box, options, hint row,
// and the user's custom statusline pinned to the very bottom.
const PERMISSION = [
  '╭──────────────────────────────────────────╮',
  '│ Bash command                             │',
  '│                                          │',
  '│   rm -rf build/                          │',
  '│                                          │',
  '│ Do you want to proceed?                  │',
  '│ ❯ 1. Yes                                 │',
  '│   2. Yes, and don\'t ask again            │',
  '│   3. No, and tell Claude what to do      │',
  '╰──────────────────────────────────────────╯',
  '  Esc to cancel',
  'claude-opus │ ~/proj │ ███░░ 65% │ task',
].join('\n');

test('returns the question line above the options', () => {
  assert.strictEqual(S.extractQuestion(PERMISSION), 'Do you want to proceed?');
});

test('ignores the user statusline at the bottom', () => {
  // The statusline is the LOWEST line on a waiting screen — without the │ / █░
  // check it would be picked as the question.
  const snap = ['│ Какой цвет иконки? │', 'model │ ~/p │ ███░ 65% │ x'].join('\n');
  assert.strictEqual(S.extractQuestion(snap), 'Какой цвет иконки?');
});

test('ignores frames, blank lines and the bare input box', () => {
  const snap = ['│ Ready to code? │', '╰────────────────╯', '', '> ', ''].join('\n');
  assert.strictEqual(S.extractQuestion(snap), 'Ready to code?');
});

test('skips option rows even when drawn inside a frame', () => {
  const snap = ['│ Pick one │', '│ ❯ 1. Blue │', '│   2. Grey │'].join('\n');
  assert.strictEqual(S.extractQuestion(snap), 'Pick one');
});

test('handles plain > and arrow option cursors', () => {
  assert.strictEqual(S.extractQuestion(['Pick one', '> 1. Blue', '  2. Grey'].join('\n')), 'Pick one');
  assert.strictEqual(S.extractQuestion(['Pick one', '▸ 1. Blue', '  2. Grey'].join('\n')), 'Pick one');
});

test('collapses inner whitespace', () => {
  assert.strictEqual(S.extractQuestion('│  Do   you   want?   │'), 'Do you want?');
});

test('truncates long questions to 80 chars with an ellipsis', () => {
  const long = 'x'.repeat(200);
  const out = S.extractQuestion(long);
  assert.strictEqual(out.length, 80);
  assert.ok(out.endsWith('…'));
});

test('returns null when nothing on screen qualifies', () => {
  assert.strictEqual(S.extractQuestion(''), null);
  assert.strictEqual(S.extractQuestion('╰──────╯\n\n> \n'), null);
  assert.strictEqual(S.extractQuestion(null), null);
});

// --- inferWaitingKind: разрешение vs вопрос ---------------------------------
// Only meaningful once the detector already decided «waiting»; it labels WHY.

test('permission chrome → permission', () => {
  // The PERMISSION fixture has numbered options too, but the permission phrasing
  // must win — so it's «разрешение», not «вопрос».
  assert.strictEqual(S.inferWaitingKind(PERMISSION), 'permission');
});

test('"Do you want" alone → permission', () => {
  const snap = ['│ Do you want to make this edit? │', '│ ❯ 1. Yes │', '│   2. No │'].join('\n');
  assert.strictEqual(S.inferWaitingKind(snap), 'permission');
});

test('numbered question without permission phrasing → question', () => {
  const snap = [
    'Какой цвет иконки?',
    '❯ 1. Синий',
    '  2. Серый',
    'model │ ~/p │ ██░ 40%',
  ].join('\n');
  assert.strictEqual(S.inferWaitingKind(snap), 'question');
});

test('plain > and arrow option cursors → question', () => {
  assert.strictEqual(S.inferWaitingKind(['Pick one', '> 1. Blue', '  2. Grey'].join('\n')), 'question');
  assert.strictEqual(S.inferWaitingKind(['Pick one', '▸ 1. Blue', '  2. Grey'].join('\n')), 'question');
});

test('«Сейчас от тебя» prose question → question', () => {
  assert.strictEqual(S.inferWaitingKind('Сейчас от тебя: путь к схеме'), 'question');
});

// --- ТЕГ на экране ------------------------------------------------------------
// Отдельно от разбора в ask-phrases.js, потому что здесь у зова есть то, чего нет ни у хука,
// ни у стенограммы: МЕБЕЛЬ Claude Code. Тег считается с начала строки, а первую строку своего
// сообщения Claude печатает как «⏺ текст» — то есть ровно там, куда мы метку и просим ставить,
// перед ней стоит чужой символ. Проверять снимок построчно нельзя: зов ищется по всей
// переписке сразу, мебель из неё не вычищена. Промах был бы молчаливым — вкладка без хуков
// просто не звала бы.
test('тег первой строкой сообщения виден сквозь маркер ⏺', () => {
  const screen = ['⏺ [swarm:вопрос]', '', '  Собрал стенд. Что ставим — заливку или точку?',
    '', '✻ Worked for 3s', '  ⏸ manual mode on'].join('\n');
  assert.strictEqual(S.asksForInput(screen), true);
  const bg = ['  ⏺ [swarm:фон]', '', '  Запустил сборку, вернусь сам.'].join('\n');
  assert.strictEqual(S.waitsForWork(bg), true);
  assert.strictEqual(S.asksForInput(bg), false);
});

test('тег последней строкой сообщения виден по отступу', () => {
  const screen = ['⏺ Собрал стенд. Что ставим?', '', '  [swarm:вопрос]', '', '> '].join('\n');
  assert.strictEqual(S.asksForInput(screen), true);
});

test('тег, названный внутри фразы, вкладку не зовёт', () => {
  // Живой случай: агент объясняет протокол или цитирует доку. Раньше меткой было любое
  // вхождение, и такой ход красил вкладку оранжевым на ровном месте.
  const screen = ['⏺ Правило такое: тег [swarm:вопрос] считается с начала строки.', '', '> '].join('\n');
  assert.strictEqual(S.asksForInput(screen), false);
  assert.strictEqual(S.waitsForWork(screen), false);
});

test('«Сейчас от тебя: ничего, жди …» is NOT a request', () => {
  assert.strictEqual(S.asksForInput('Сейчас от тебя: ничего, жди результата ревью'), false);
  assert.strictEqual(S.asksForInput('Сейчас от тебя — ничего не нужно'), false);
  assert.strictEqual(S.asksForInput('Сейчас от тебя: подожди, пока соберётся билд'), false);
  assert.strictEqual(S.asksForInput('Сейчас от тебя: жди'), false);
});

test('«Сейчас от тебя: ничего, жду …» — не зов, но и не «готов»', () => {
  // Ход закрыт фоновой задачей: отвечать нечего, а вкладка занята — фон разбудит агента.
  assert.strictEqual(S.asksForInput('Сейчас от тебя: ничего, жду замер стенда'), false);
  assert.strictEqual(S.waitsForWork('Сейчас от тебя: ничего, жду замер стенда'), true);
  assert.strictEqual(S.waitsForWork('Сейчас от тебя: ничего, ждём сборку'), true);
  // Повелительное «жди результата» — это «я закончил», вкладка свободна.
  assert.strictEqual(S.waitsForWork('Сейчас от тебя: ничего, жди результата'), false);
  assert.strictEqual(S.waitsForWork('Сейчас от тебя: путь к схеме'), false);
  assert.strictEqual(S.waitsForWork('обычный вывод без маркера'), false);
});

test('«Сейчас от тебя: <настоящий запрос>» IS a request', () => {
  assert.strictEqual(S.asksForInput('Сейчас от тебя: путь к схеме'), true);
  assert.strictEqual(S.asksForInput('Сейчас от тебя: подтверди, ничего не удаляй'), true);
  assert.strictEqual(S.asksForInput('обычный вывод без маркера'), false);
});

test('a «ничего, жди» sign-off does NOT classify as question via the marker', () => {
  // extractQuestion may still pick the line, but the ask-marker path must not fire.
  assert.strictEqual(S.asksForInput('Сейчас от тебя: ничего, жди результата ревью'), false);
});

test('a bare prose question line → question', () => {
  assert.strictEqual(S.inferWaitingKind(['│ Какой выбрать вариант? │', 'model │ ~/p │ ██░ 40%'].join('\n')), 'question');
});

test('quiet screen with nothing to ask → null (generic «ждёт»)', () => {
  assert.strictEqual(S.inferWaitingKind('>\n'), null);
  assert.strictEqual(S.inferWaitingKind(''), null);
  assert.strictEqual(S.inferWaitingKind(null), null);
});

// The sub-agent status line Claude pins above the input box (real capture). It
// stays whether the main turn is busy or the prompt is idle.
const WAITING4 = [
  '✻ Waiting for 4 background agents to finish',
  '─────────────────────────────────────────',
  '❯ ',
  '─────────────────────────────────────────',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents · ↓ to manage',
  '',
  '  ⏺ main',
  '  ◯ Explore  Long probe A: status detector          2m 2s · ↓ 28.4k tokens',
  '  ◯ Explore  Long probe B: renderer status flow     1m 59s · ↓ 28.7k tokens',
  '  ◯ Explore  Long probe C: settings UI              1m 55s · ↓ 39.1k tokens',
  '  ◯ Explore  Long probe D: tabstyle model           1m 50s · ↓ 23.8k tokens',
].join('\n');

test('countSubagents reads the "Waiting for N" count', () => {
  assert.strictEqual(S.countSubagents(WAITING4), 4);
});

test('countSubagents handles the singular "1 background agent"', () => {
  assert.strictEqual(S.countSubagents('✻ Waiting for 1 background agent to finish'), 1);
});

test('countSubagents returns 0 when no sub-agents are on screen', () => {
  assert.strictEqual(S.countSubagents(PERMISSION), 0);
  assert.strictEqual(S.countSubagents(''), 0);
  assert.strictEqual(S.countSubagents(null), 0);
});

test('countSubagents falls back to counting hollow-circle roster rows', () => {
  // No "Waiting for N" line (roster shown without it): count only running rows.
  const roster = [
    '  ⏺ main',
    '  ◯ Explore  probe A   19s · ↓ 9.3k tokens',
    '  ◯ Plan     probe B   15s · ↓ 11.5k tokens',
    '  ⏺ Explore  probe C   Done (12 tool uses · 8k tokens · 40s)', // finished — filled, not counted
  ].join('\n');
  assert.strictEqual(S.countSubagents(roster), 2);
});

// A minimal stand-in for an xterm buffer: rows of text, plus the blank tail a
// shrinking TUI frame leaves behind (see snapshotRows in screen.js).
function fakeBuf(rows) {
  return {
    length: rows.length,
    getLine: (y) => (rows[y] == null ? null : { translateToString: () => rows[y] }),
  };
}

test('contentEnd ignores blank rows below the screen content', () => {
  assert.strictEqual(S.contentEnd(fakeBuf(['a', 'b', '', '   ', ''])), 2);
  assert.strictEqual(S.contentEnd(fakeBuf(['a', 'b'])), 2);
  assert.strictEqual(S.contentEnd(fakeBuf(['', '  '])), 0);
  assert.strictEqual(S.contentEnd(fakeBuf([])), 0);
});

test('snapshotRows takes the last rows WITH content, not the last rows of the buffer', () => {
  const rows = ['вопрос', 'хвост', '', '', '', ''];   // 4 blank rows below the content
  assert.strictEqual(S.snapshotRows(fakeBuf(rows), 2), 'вопрос\nхвост');
  // Fewer rows of content than asked for: return what there is, no padding.
  assert.strictEqual(S.snapshotRows(fakeBuf(rows), 16), 'вопрос\nхвост');
});

// --- строка статуса, в том числе перенесённая ---------------------------------
// Ряды с пометкой переноса: fakeBuf выше её не знает, а здесь она — весь смысл.
function wrapBuf(rows) {
  return {
    length: rows.length,
    getLine: (y) => (rows[y] == null ? null : {
      isWrapped: !!rows[y].wrapped,
      translateToString: () => rows[y].text,
    }),
  };
}

test('statuslineOf берёт нижний ряд, похожий на строку статуса', () => {
  const buf = wrapBuf([{ text: 'какой-то вывод' }, { text: 'Opus 5 │ repo ██░ 24% 1M' }, { text: '' }]);
  assert.strictEqual(S.statuslineOf(buf, 16), 'Opus 5 │ repo ██░ 24% 1M');
  assert.strictEqual(S.statuslineOf(wrapBuf([{ text: 'ничего похожего' }]), 16), '');
});

test('перенесённая строка возвращается ЦЕЛИКОМ, а не одним хвостом', () => {
  // Своя строка человека печатается следом за нашей, и вдвоём они переносятся. Снизу
  // первым попадается хвост — вернуть его значило бы отдать вкладке чужой процент как
  // контекст, а на этом проценте стоит и перезапуск.
  const buf = wrapBuf([
    { text: 'какой-то вывод' },
    { text: 'Opus 5 │ repo ██░ 24% 1M │ 5ч 37% │ ' },
    { text: 'моя строка 99% диска', wrapped: true },
  ]);
  const line = S.statuslineOf(buf, 16);
  assert.strictEqual(line, 'Opus 5 │ repo ██░ 24% 1M │ 5ч 37% │ моя строка 99% диска');
  assert.strictEqual(line.match(/(\d+)%/)[1], '24', 'первым остаётся НАШ процент');

  // Тот же перенос, но разделитель уехал в ХВОСТ: снизу первым попадается он, и голову
  // надо добрать вверх — иначе вкладка получит чужую строку вместо нашей.
  const tailFirst = wrapBuf([
    { text: 'какой-то вывод' },
    { text: 'Opus 5 ███ 24% 1M ' },
    { text: '│ моя строка 99% диска', wrapped: true },
  ]);
  assert.strictEqual(S.statuslineOf(tailFirst, 16), 'Opus 5 ███ 24% 1M │ моя строка 99% диска');

  // И перенос на три ряда — собираем все.
  const three = wrapBuf([
    { text: 'Opus 5 │ repo ' },
    { text: '███ 24% 1M ', wrapped: true },
    { text: '│ моя строка', wrapped: true },
  ]);
  assert.strictEqual(S.statuslineOf(three, 16), 'Opus 5 │ repo ███ 24% 1M │ моя строка');
});

test('добор переноса не втягивает обёрнутую прозу выше', () => {
  // Ровно тот случай, из-за которого полоска врала: длинная фраза агента переносится
  // ряд за рядом и упирается в строку статуса, а цепочка isWrapped тянется через весь
  // абзац. Раньше строка статуса возвращалась вместе с ним, и первым процентом в ней
  // оказывался процессорный.
  const rows = [{ text: 'не могу прогнать тесты, ' }];
  for (let i = 0; i < 8; i++) rows.push({ text: 'процессор загружен на 80% ', wrapped: true });
  rows.push({ text: 'Opus 5 │ repo ██░ 24% 1M', wrapped: true });
  const line = S.statuslineOf(wrapBuf(rows), 16);
  assert.ok(!line.includes('не могу прогнать'), 'проза в строку статуса не попадает');
  assert.ok(line.endsWith('Opus 5 │ repo ██░ 24% 1M'));
});

// --- процент контекста из строки: только у полоски блоков ---------------------
test('ctxFromLine берёт процент вплотную к полоске, а не первый в строке', () => {
  assert.strictEqual(S.ctxFromLine('Opus 5 │ repo ██░ 24% 1M │ 5ч 37%'), 24);
  assert.strictEqual(S.ctxFromLine('процессор загружен на 80% ██░ 24% 1M'), 24);
  assert.strictEqual(S.ctxFromLine('💀 ██████████ 100% 1M'), 100);
});

test('ctxFromLine молчит там, где полоски контекста нет', () => {
  assert.strictEqual(S.ctxFromLine('не могу прогнать тесты, процессор загружен на 80%'), null);
  assert.strictEqual(S.ctxFromLine('Opus 5 │ repo │ 5ч 37%'), null);
  assert.strictEqual(S.ctxFromLine(''), null);
  assert.strictEqual(S.ctxFromLine(null), null);
});

test('snapshotRows keeps blank rows that sit BETWEEN content', () => {
  assert.strictEqual(S.snapshotRows(fakeBuf(['a', '', 'b', '']), 16), 'a\n\nb');
});

// --- the input box's own furniture is not a question --------------------------
// Straight from a live run: this is what got sent to Telegram as «❓ вопрос».

test('extractQuestion skips the mode line under the input box', () => {
  const snap = [
    'Сейчас от тебя: катать миграцию сразу или ждать релиза?',
    '',
    '> ',
    '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
  ].join('\n');
  assert.strictEqual(S.extractQuestion(snap), 'Сейчас от тебя: катать миграцию сразу или ждать релиза?');
});

test('extractQuestion skips the rest of Claude Code chrome', () => {
  for (const junk of [
    '⏵⏵ accept edits on (shift+tab to cycle)',
    '⏸ plan mode on (shift+tab to cycle)',
    '? for shortcuts',
    'Context left until auto-compact: 25%',
    'esc to interrupt',
    'ctrl+r to expand',
    '✻ Cooking… (12s · esc to interrupt)',
  ]) {
    assert.strictEqual(S.extractQuestion('Какой вариант берём?\n' + junk), 'Какой вариант берём?', junk);
  }
});

test('extractQuestion returns null rather than chrome when there is no prose', () => {
  assert.strictEqual(S.extractQuestion('> \n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents'), null);
});

// --- линейка с числом внутри — не вопрос -------------------------------------
// Из живого случая: в уведомлении вместо вопроса пришли «полоски». Пустую линейку
// отсеивала проверка «есть ли текст», но цифра внутри линейки её проходит, и строка
// уезжала целиком. Полосками это выглядит потому, что в уведомление влезает 140
// символов: на широком терминале число стоит правее обрезки, и человек видит только
// дефисы. Поэтому вопросом считается только строка С БУКВОЙ.
test('a rule with a number in it is furniture, not a question', () => {
  for (const rule of [
    '──────────── 3 ────────────',
    '════════════ 45% ════════════',
    '╌╌╌╌╌╌╌╌ 12 ╌╌╌╌╌╌╌╌',
    '─'.repeat(200) + ' 7',        // именно этот вид и приходил обрезанным в полоски
  ]) {
    assert.strictEqual(S.extractQuestion(rule + '\n\n> \n'), null, rule.slice(0, 24));
    assert.strictEqual(S.lastAgentLine(rule + '\n\n> \n'), null, rule.slice(0, 24));
  }
});

// --- мой собственный ответ — не вопрос ---------------------------------------
// Из живого случая: вкладка спросила, я ответил и переключился — и получил уведомление со
// СВОИМ ЖЕ ответом в тексте. Отправленную реплику Claude Code оставляет в переписке как
// «> текст», то есть она лежит НИЖЕ вопроса, а вопрос ищется снизу вверх.
test('extractQuestion skips my own submitted reply', () => {
  const snap = [
    '⏺ Готово: миграция подготовлена.',
    '',
    '  Сейчас от тебя: решить, гоняем ли миграцию сейчас.',
    '',
    '> да, гоняй',
    '',
    '> ',
    '  ⏸ manual mode on',
  ].join('\n');
  assert.strictEqual(S.extractQuestion(snap), 'Сейчас от тебя: решить, гоняем ли миграцию сейчас.');
  for (const mine of ['> да, гоняй', '❯ поправь заголовок', '» ладно']) {
    assert.strictEqual(S.extractQuestion('Какой вариант берём?\n' + mine), 'Какой вариант берём?', mine);
  }
});

// --- отпечаток зова: тот же зов или новый ------------------------------------
test('askFingerprint: тот же зов на экране — тот же отпечаток', () => {
  const before = ['  Сейчас от тебя: решить, гоняем ли миграцию.', '', '> '].join('\n');
  const after = ['  Сейчас от тебя: решить, гоняем ли миграцию.', '', '> да, гоняй', '', '> '].join('\n');
  assert.ok(S.askFingerprint(before), 'зов на экране есть');
  assert.strictEqual(S.askFingerprint(after), S.askFingerprint(before), 'мой ответ ниже зова его не меняет');
});

test('askFingerprint: новый зов и повтор слово в слово меняют отпечаток', () => {
  const one = 'Сейчас от тебя: решить, гоняем ли миграцию.';
  const two = 'Сейчас от тебя: путь к схеме.';
  const fp = S.askFingerprint(one);
  assert.notStrictEqual(S.askFingerprint(two), fp, 'другой зов');
  assert.notStrictEqual(S.askFingerprint(one + '\n> да\n' + one), fp, 'тот же зов дважды — это второй зов');
});

test('askFingerprint: без зова отпечатка нет (в т.ч. «ничего, жди»)', () => {
  assert.strictEqual(S.askFingerprint('обычный вывод\n> '), '');
  assert.strictEqual(S.askFingerprint('Сейчас от тебя: ничего, жди результата'), '');
  assert.strictEqual(S.askFingerprint(null), '');
});

test('a title framed by rules keeps the title and drops the rules', () => {
  assert.strictEqual(S.extractQuestion('──── Bash command ────\n\n> \n'), 'Bash command');
  assert.strictEqual(S.extractQuestion('╭─ Plan ─────────────╮\n\n> \n'), 'Plan');
});

test('a real question is still a question after the rule guard', () => {
  // Страховка от переусердствования: вопрос с числами, процентами и тире остаётся собой.
  const q = 'Ставить лимит 45% или 3 попытки — как решим?';
  assert.strictEqual(S.extractQuestion(q + '\n\n> \n'), q);
  assert.strictEqual(S.lastAgentLine('⏺ ' + q + '\n\n> \n'), q);
});

// --- parsePrompt: the prompt box as something answerable from a phone ---------

const PERM = [
  '╭──────────────────────────────────────────╮',
  '│ Bash command                             │',
  '│ rm -rf build                             │',
  '│ Do you want to proceed?                  │',
  '│ ❯ 1. Yes                                 │',
  '│   2. Yes, and don\'t ask again            │',
  '│   3. No, and tell Claude what to do      │',
  '╰──────────────────────────────────────────╯',
  '  Esc to cancel',
].join('\n');

// --- режим разрешений: читаем, прежде чем жать Shift+Tab ----------------------
// Строка режима — из живого Claude Code 2.1.220. Жать вслепую нельзя: /mode из телеги
// переключает по кругу и должен ВИДЕТЬ, куда попал, иначе это стрельба в темноте.

// Строки сняты с живого Claude Code 2.1.220 нажатиями Shift+Tab по кругу. Порядок круга:
// manual → accept edits → plan → auto → manual. Четыре режима, и «auto» — САМОСТОЯТЕЛЬНЫЙ,
// а не синоним «accept edits»: из-за этой путаницы «/mode auto» останавливался на правках.
const MODE_LINES = [
  ['⏸ manual mode on · ? for shortcuts · ← for agents', 'manual'],
  ['⏵⏵ accept edits on (shift+tab to cycle) · ← for agents', 'accept-edits'],
  ['⏸ plan mode on (shift+tab to cycle) · ← for agents', 'plan'],
  ['⏵⏵ auto mode on (shift+tab to cycle) · ← for agents', 'auto'],
];

test('readMode узнаёт все четыре режима живого Claude Code', () => {
  for (const [line, id] of MODE_LINES) {
    assert.strictEqual(S.readMode('  ' + line), id, line);
  }
  assert.strictEqual(S.readMode('  ⏵⏵ bypassing permissions'), 'bypass');
});

// Цена у режимов разная, и подписи не должны её смазывать: accept edits разрешает ТОЛЬКО
// правки, а auto судит каждое действие сам. Обещать одно, делая другое, здесь недопустимо.
test('modeTitle различает «правки без спроса» и «авто»', () => {
  assert.match(S.modeTitle('accept-edits'), /правки без спроса/);
  assert.match(S.modeTitle('accept-edits'), /остальное спрашивает/);
  assert.match(S.modeTitle('auto'), /сам решает/);
  assert.notStrictEqual(S.modeTitle('auto'), S.modeTitle('accept-edits'));
  assert.match(S.modeTitle('manual'), /спрашивает разрешение/);
  assert.match(S.modeTitle('plan'), /план/);
});

// В обратную сторону подпись врать тоже не должна. Здесь стояло «делает всё без вопросов», а
// auto в 2.1.220 всё равно спрашивает на опасном (65 категорий, `claude auto-mode defaults`):
// человек нажимал «вообще без вопросов», получал запрос разрешения и решал, что режим не
// переключился. Настоящая тишина — только bypass, и вот он про неё и говорит.
test('подпись auto не обещает тишины, которой не будет', () => {
  assert.doesNotMatch(S.modeTitle('auto'), /без вопросов|ни о чём|не спрашивает/);
  assert.match(S.modeTitle('auto'), /спрашивает только на опасном/);
  assert.match(S.modeTitle('bypass'), /без спроса совсем/);
});

// Соответствие «наш режим → значение --permission-mode». Расхождение здесь не деградирует:
// неизвестное значение claude не проглатывает, он отказывается стартовать, и вкладка
// встречает человека мёртвой оболочкой вместо агента.
test('у каждого режима есть флаг Claude Code, и написание точное', () => {
  assert.deepStrictEqual(S.modeFlag('manual'), 'manual');
  assert.deepStrictEqual(S.modeFlag('accept-edits'), 'acceptEdits');
  assert.deepStrictEqual(S.modeFlag('plan'), 'plan');
  assert.deepStrictEqual(S.modeFlag('auto'), 'auto');
  assert.deepStrictEqual(S.modeFlag('bypass'), 'bypassPermissions');
  // Ни один режим не должен остаться без флага: список режимов и список флагов обязаны
  // совпадать по ключам, иначе селект в настройках предложит то, что не запустится.
  assert.deepStrictEqual(Object.keys(S.MODE_FLAGS).sort(), Object.keys(S.MODE_TITLES).sort());
  // Только те значения, которые понимает живой `--permission-mode` (claude --help, 2.1.220).
  const KNOWN = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
  for (const flag of Object.values(S.MODE_FLAGS)) assert.ok(KNOWN.includes(flag), flag);
});

test('modeFlag не выдумывает флаг для неизвестного режима', () => {
  // Иначе в командную строку уехало бы `--permission-mode undefined`, и вкладка не стартует.
  assert.strictEqual(S.modeFlag('нет такого'), null);
  assert.strictEqual(S.modeFlag(''), null);
  assert.strictEqual(S.modeFlag(null), null);
});

// Иначе фраза агента «давай обсудим plan mode» переключала бы режим по кругу вслепую.
test('readMode не принимает прозу агента за строку режима', () => {
  assert.strictEqual(S.readMode('⏺ Давай обсудим plan mode для этой задачи'), null);
  assert.strictEqual(S.readMode(''), null);
  assert.strictEqual(S.readMode(null), null);
});

test('readMode берёт НИЖНЮЮ строку режима, а не первую попавшуюся', () => {
  const scr = ['⏺ Раньше был accept edits mode on, теперь нет',
    '────────', '❯ ', '  ⏸ plan mode on (shift+tab to cycle)'].join('\n');
  assert.strictEqual(S.readMode(scr), 'plan');
});

test('modeTitle объясняет режим по-русски, а неизвестный не роняет', () => {
  assert.match(S.modeTitle('accept-edits'), /без спроса/);
  assert.strictEqual(S.modeTitle('нет такого'), 'нет такого');
  assert.strictEqual(S.modeTitle(null), 'неизвестный');
});

// НАСТОЯЩИЙ экран после законченного хода — то, что видит мост, когда стенограмма не
// привязана и текст итога приходится брать с экрана. Снят с живого TUI.
const SCREEN_DONE = [
  '⏺ I\'ll run that in your working directory.',
  '',
  '  Listed 1 directory ',
  '',
  '⏺ 0B . — рабочая директория пустая.',
  '',
  '✻ Churned for 7s',
  '',
  '────────────────────────────────────────────────────────────────────────',
  '❯ проверь, нажимается ли кнопка разрешения',
  '────────────────────────────────────────────────────────────────────────',
  '  ⏸ manual mode on · ? for shortcuts · ← for agents',
].join('\n');

// Живой случай: в телегу как «ответ агента» уезжала то линейка рамки, то собственный
// вопрос пользователя из поля ввода. Отчёт обязан быть тем, что сказал АГЕНТ.
test('lastAgentLine берёт фразу агента, а не поле ввода и не рамку', () => {
  assert.strictEqual(S.lastAgentLine(SCREEN_DONE), '0B . — рабочая директория пустая.');
});

test('lastAgentLine не возвращает текст человека ни при каких условиях', () => {
  const only = ['────────────', '❯ проверь, нажимается ли кнопка разрешения', '────────────',
    '  ⏸ manual mode on'].join('\n');
  assert.strictEqual(S.lastAgentLine(only), null, 'на экране нет слов агента — значит null');
  assert.ok(!/проверь/.test(String(S.lastAgentLine(SCREEN_DONE))), 'вопрос человека не отчёт');
});

test('lastAgentLine пропускает служебные строки Claude Code', () => {
  assert.strictEqual(S.lastAgentLine('⏺ Готово.\n✻ Worked for 3s\n  ⏸ manual mode on'), 'Готово.');
  assert.strictEqual(S.lastAgentLine(''), null);
  assert.strictEqual(S.lastAgentLine(null), null);
});

// НАСТОЯЩИЙ экран Claude Code 2.1.220, снятый с живого TUI (pty + xterm), а не придуманный.
// Фикстура выше (PERM) — в рамке, и ровно поэтому тесты были зелёными, пока бот в бою
// отвечал «вариантов не разобрал» на КАЖДЫЙ запрос разрешения: настоящий диалог рисуется
// без вертикальной рамки, только горизонтальными линейками, а парсер требовал рамку.
const PERM_REAL_EDIT = [
  '❯ Создай файл zametka.txt со словом привет. Только это, без объяснений.                             ',
  '',
  '⏺ Write(zametka.txt)',
  '',
  '────────────────────────────────────────────────────────────────────────────────────────────────────',
  ' Create file',
  ' zametka.txt',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  '  1 привет',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  ' Do you want to create zametka.txt?',
  ' ❯ 1. Yes',
  '   2. Yes, allow all edits during this session (shift+tab)',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n');

// Второй настоящий: «доверяешь ли папке» на первом запуске в новой папке. Тоже без рамки.
const PERM_REAL_TRUST = [
  ' Claude Code\'ll be able to read, edit, and execute files here.',
  '',
  ' Security guide',
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

// НАСТОЯЩИЙ запрос на команду, снятый с живого TUI. Здесь самое важное — САМА КОМАНДА —
// лежит выше пустых строк, и прежний сбор заголовка (пять строк вверх, пустые тратили
// бюджет) до неё не доходил: в телегу уезжало голое «Do you want to proceed?», по которому
// нельзя решить, разрешать или нет.
const PERM_REAL_BASH = [
  '⏺ Running 1 shell command…',
  '  ⎿  $ touch /tmp/swarm-perm-probe.txt',
  '',
  '────────────────────────────────────────────────────────────────────────────────',
  ' Bash command',
  '',
  '   touch /tmp/swarm-perm-probe.txt',
  '   Create empty probe file in /tmp',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and always allow access to tmp/ from this project',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend · ctrl+e to explain',
].join('\n');

test('parsePrompt даёт КОМАНДУ, а не голое «Do you want to proceed?»', () => {
  const p = S.parsePrompt(PERM_REAL_BASH);
  assert.ok(p, 'настоящий диалог обязан разбираться');
  assert.match(p.title, /touch \/tmp\/swarm-perm-probe\.txt/, 'команда обязана быть: ' + p.title);
  assert.match(p.title, /Bash command/, 'вид запроса тоже: ' + p.title);
  assert.match(p.title, /Create empty probe file/, 'объяснение агента полезно: ' + p.title);
  assert.match(p.title, /Do you want to proceed\?/);
  assert.ok(!/Esc to cancel/.test(p.title), 'подсказка не заголовок: ' + p.title);
  assert.deepStrictEqual(p.options.map((o) => o.n), [1, 2, 3]);
});

test('parsePrompt разбирает НАСТОЯЩИЙ запрос разрешения (без рамки, с линейками)', () => {
  const p = S.parsePrompt(PERM_REAL_EDIT);
  assert.ok(p, 'настоящий диалог обязан разбираться — иначе кнопок нет вообще');
  assert.deepStrictEqual(p.options.map((o) => o.n), [1, 2, 3]);
  assert.strictEqual(p.options[0].text, 'Yes');
  assert.strictEqual(p.options[2].text, 'No');
  // В заголовке — ЧТО именно делают: вид запроса, файл и вопрос.
  assert.match(p.title, /Create file/, p.title);
  assert.match(p.title, /zametka\.txt/, p.title);
  assert.match(p.title, /Do you want to create zametka\.txt\?/, p.title);
  // Но НЕ содержимое файла: строки диффа — это не то, что одобряют кнопкой.
  assert.ok(!/привет/.test(p.title), 'содержимое файла не заголовок: ' + p.title);
  assert.ok(!/Tab to amend/.test(p.title), 'подсказка не заголовок: ' + p.title);
});

test('parsePrompt разбирает НАСТОЯЩИЙ вопрос про доверие папке', () => {
  const p = S.parsePrompt(PERM_REAL_TRUST);
  assert.ok(p, 'диалог доверия тоже отвечается номером');
  assert.deepStrictEqual(p.options.map((o) => o.text), ['Yes, I trust this folder', 'No, exit']);
});

// ВОПРОС С ВАРИАНТАМИ (AskUserQuestion), снятый с живого Claude Code 2.1.220 через pty. От
// запроса разрешения он отличается тем, что у каждого варианта СВОЯ строка описания, — и
// именно на этом мост ломался: разрыв между номерами стал больше GAP_MAX, блок рассыпался,
// уведомление уходило без кнопок с подписью «вариантов не разобрал». Дальше начинался тупик:
// выбрать нечем, а прозу в открытый диалог мост не печатает, — то есть с телефона на вопрос
// агента нельзя было ответить вообще никак.
const QUIZ_REAL = [
  ' ☐ Фон ',
  '',
  'Какой цвет фона выбрать?',
  '',
  '❯ 1. Светлый',
  '     Тёмный текст на светлом фоне. Хорошо читается при ярком освещении и днём.',
  '  2. Тёмный',
  '     Светлый текст на тёмном фоне. Меньше устают глаза в темноте, экономнее для OLED.',
  '  3. Системный',
  '     Следует настройке оформления в ОС и переключается автоматически вместе с ней.',
  '  4. Type something.',
  '────────────────────────────────────────────────────────────────────────────────',
  '  5. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

// То же, но в УЗКОМ окне: описание не влезает в строку и переносится. Ширина окна — свойство
// того, кто смотрит, и разбор от неё зависеть не должен.
const QUIZ_WRAPPED = [
  ' ☐ Починка ',
  '',
  'Что починить в сворме?',
  '',
  '❯ 1. Конфиг вкладки целиком',
  '     Сворм узнаёт, с каким CLAUDE_CONFIG_DIR запущена вкладка, ищет',
  '     стенограмму в его projects и ставит туда свои хуки.',
  '  2. Только стенограмма',
  '     Искать файл разговора во всех конфигах. Мусор в чате уйдёт, но статус',
  '     этих вкладок останется на экранном детекторе.',
  '  3. Type something.',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

test('parsePrompt разбирает НАСТОЯЩИЙ вопрос с вариантами и описаниями', () => {
  const p = S.parsePrompt(QUIZ_REAL);
  assert.ok(p, 'без кнопок этот вопрос с телефона неотвечаем');
  assert.deepStrictEqual(p.options.map((o) => o.n), [1, 2, 3, 4, 5]);
  assert.strictEqual(p.options[0].text, 'Светлый');
  assert.strictEqual(p.options[3].text, 'Type something.');
  assert.match(p.title, /Какой цвет фона выбрать\?/, p.title);
  // Описание варианта — не заголовок: в подписи кнопки и в тексте запроса ему нечего делать.
  assert.ok(!/Меньше устают глаза/.test(p.title), 'описание не заголовок: ' + p.title);
});

test('parsePrompt держит вопрос, у которого описания перенеслись на две строки', () => {
  const p = S.parsePrompt(QUIZ_WRAPPED);
  assert.ok(p, 'перенос описания — это ширина окна, а не другой диалог');
  assert.deepStrictEqual(p.options.map((o) => o.n), [1, 2, 3]);
  assert.strictEqual(p.options[1].text, 'Только стенограмма');
});

// Но разрыв разрешён РОВНО для описаний: строки с отступом глубже номера. Нумерованный список
// в прозе агента кнопками стать не должен — нажатие печатало бы «1» в диалог, который стоит
// ниже, то есть одобряло бы не то, что на кнопке написано.
test('нумерованный список в прозе агента кнопками не становится', () => {
  const prose = [
    'Предлагаю план:',
    '',
    '1. Переписать оплату',
    '   она держится на вебхуках',
    '',
    '2. Потом отчёты',
    '   их читает только бухгалтерия',
    '',
    'Готово.',
  ].join('\n');
  assert.strictEqual(S.parsePrompt(prose), null);
});

test('parsePrompt returns every option Claude offered, numbered', () => {
  const p = S.parsePrompt(PERM);
  assert.deepStrictEqual(p.options.map((o) => o.n), [1, 2, 3]);
  assert.strictEqual(p.options[0].text, 'Yes');
  assert.strictEqual(p.options[2].text, 'No, and tell Claude what to do');
});

test('parsePrompt keeps the command being approved in the title', () => {
  const p = S.parsePrompt(PERM);
  assert.ok(p.title.includes('rm -rf build'), p.title);
  assert.ok(p.title.includes('Do you want to proceed?'), p.title);
  assert.ok(!/Esc to cancel/.test(p.title), 'chrome must not leak into the title');
});

test('parsePrompt НЕ берёт нумерованный список из прозы над запросом', () => {
  // Ровно то, что нашло ревью: кнопка «1. переписать модуль оплаты» печатала бы «1»
  // в диалог ниже, то есть одобряла бы rm -rf build.
  const snap = [
    'Предлагаю план:',
    '1. переписать модуль оплаты',
    '2. удалить старый клиент',
    '╭──────────────────────────────────────────╮',
    '│ Bash command                             │',
    '│ rm -rf build                             │',
    '│ Do you want to proceed?                  │',
    '│ ❯ 1. Yes                                 │',
    '│   2. No, and tell Claude what to do      │',
    '╰──────────────────────────────────────────╯',
  ].join('\n');
  const p = S.parsePrompt(snap);
  assert.deepStrictEqual(p.options.map((o) => o.text), ['Yes', 'No, and tell Claude what to do']);
  assert.ok(p.title.includes('rm -rf build'), 'команда обязана быть в тексте: ' + p.title);
  assert.ok(!/переписать/.test(p.title), 'проза не должна попадать в заголовок');
});

test('parsePrompt игнорирует список без рамки — это не запрос', () => {
  assert.strictEqual(S.parsePrompt('Варианты:\n1. один\n2. два\n> '), null);
});

test('parsePrompt требует нумерацию с 1 без дублей', () => {
  const snap = ['│ Do you want to proceed? │', '│ 2. Yes │', '│ 2. No │'].join('\n');
  assert.strictEqual(S.parsePrompt(snap), null);
});

test('parsePrompt says null when there is no choice on screen', () => {
  assert.strictEqual(S.parsePrompt('Просто текст\n> '), null);
  assert.strictEqual(S.parsePrompt('❯ 1. Yes'), null, 'a single option is not a choice');
  assert.strictEqual(S.parsePrompt(''), null);
});

test('parsePrompt fingerprint changes with the prompt, not with its repaint', () => {
  const a = S.parsePrompt(PERM).fingerprint;
  // Same prompt, redrawn with the cursor on another option and different padding.
  const redrawn = PERM.replace('❯ 1. Yes', '  1. Yes').replace('  2. Yes', '❯ 2. Yes');
  assert.strictEqual(S.parsePrompt(redrawn).fingerprint, a, 'a repaint is not a new request');
  const other = PERM.replace('rm -rf build', 'rm -rf /');
  assert.notStrictEqual(S.parsePrompt(other).fingerprint, a, 'another command IS a new request');
});

test('parsePrompt caps a long option label so it fits a button', () => {
  const long = PERM.replace('2. Yes, and don\'t ask again', '2. ' + 'да '.repeat(60));
  const opt = S.parsePrompt(long).options.find((o) => o.n === 2);
  assert.ok(opt.text.length <= 58, opt.text.length);
  assert.ok(opt.text.endsWith('…'));
});

// --- весь ответ с экрана, а не одна строка -----------------------------------
// Живой случай: в телегу уезжал огрызок — последняя строка ответа, иногда прямо с
// подсказкой Claude Code («Jump to bottom (click) ↓») вместо слов агента.
const SCREEN_REPLY = [
  '⏺ Bash(npm test)',
  '  ⎿ 42 tests passed',
  '',
  '⏺ Готово. Что сделано:',
  '',
  '  - починил сборку',
  '  - обновил тесты',
  '',
  '  Сейчас от тебя: ничего, жди выпуска.',
  '',
  '  Jump to bottom (click) ↓',
  '╭────────────────────────────────╮',
  '│ >                              │',
  '╰────────────────────────────────╯',
  '  ⏵⏵ auto mode on · ? for shortcuts · ← for agents',
].join('\n');

test('lastAgentBlock отдаёт сообщение агента целиком, с абзацами', () => {
  const got = S.lastAgentBlock(SCREEN_REPLY);
  assert.strictEqual(got, [
    'Готово. Что сделано:',
    '',
    '- починил сборку',
    '- обновил тесты',
    '',
    'Сейчас от тебя: ничего, жди выпуска.',
  ].join('\n'));
});

test('lastAgentBlock не берёт мебель, вывод инструмента и прошлые сообщения', () => {
  const got = String(S.lastAgentBlock(SCREEN_REPLY));
  assert.ok(!/Jump to bottom/.test(got), 'подсказка Claude Code — не ответ агента');
  assert.ok(!/42 tests passed/.test(got), 'вывод инструмента ⎿ — не ответ агента');
  assert.ok(!/npm test/.test(got), 'прошлое сообщение осталось за границей');
  assert.ok(!/auto mode on/.test(got), 'строка режима — мебель');
});

test('lastAgentBlock не выдаёт за ответ текст человека', () => {
  assert.strictEqual(S.lastAgentBlock(SCREEN_DONE), '0B . — рабочая директория пустая.');
  const only = ['────────────', '❯ проверь, нажимается ли кнопка', '────────────',
    '  ⏸ manual mode on'].join('\n');
  assert.strictEqual(S.lastAgentBlock(only), null, 'слов агента на экране нет — значит null');
  assert.strictEqual(S.lastAgentBlock(''), null);
  assert.strictEqual(S.lastAgentBlock(null), null);
});

// Живой случай: восстановленная вкладка ещё не привязала стенограмму, текст берётся с
// экрана — и в телегу уехали «● high · /effort» и имя сессии как «ответ агента». Это
// мебель Claude Code 2.1.220 и наша собственная подпись вкладки, и ни то ни другое никто
// не писал.
test('строка усилия и имя сессии — мебель, а не слова агента', () => {
  const scr = ['⏺ Собрал релиз, тесты зелёные.', '', '> ', '  ● high · /effort',
    '  swarm-f81789c0 · bnmap-common'].join('\n');
  assert.strictEqual(S.lastAgentBlock(scr), 'Собрал релиз, тесты зелёные.');
  const only = ['  ● high · /effort', '  swarm-f81789c0 · bnmap-common', '> '].join('\n');
  assert.strictEqual(S.lastAgentBlock(only), null, 'кроме мебели на экране ничего нет');
  assert.strictEqual(S.extractQuestion(only), null);
});

// Мост зовёт lastAgentBlock без предела: в чат уходит всё, что агент сказал.
test('lastAgentBlock без предела не режет ничего', () => {
  const long = 'я'.repeat(9000);
  assert.strictEqual(S.lastAgentBlock('⏺ ' + long + '\n\n> \n'), long);
});

test('lastAgentBlock уважает предел длины, если его задали', () => {
  const got = S.lastAgentBlock(SCREEN_REPLY, 24);
  assert.ok(got.length <= 24, got.length);
  assert.ok(got.endsWith('…'), got);
});

// Runs LAST: it swaps the module-level matcher, and restores it at the end.
test('setAskPhrases swaps the marker the scraper looks for', () => {
  try {
    S.setAskPhrases(['Жду твоего слова']);
    assert.strictEqual(S.asksForInput('Жду твоего слова по деплою'), true);
    assert.strictEqual(S.asksForInput('Сейчас от тебя: путь'), false, 'default is no longer active');
    assert.strictEqual(S.inferWaitingKind('Жду твоего слова'), 'question');
    assert.strictEqual(S.asksForInput('Жду твоего слова: ничего, жди'), false);
  } finally {
    S.setAskPhrases([]); // back to the shipped default
  }
  assert.strictEqual(S.asksForInput('Сейчас от тебя: путь'), true);
});

// --- плашка «вернуться вниз»: экран отлистан и ему нельзя верить ---------------
// Строки сняты с живого claude 2.1.220 (колесо вверх в pty, снимок глазами
// детектора): плашка ложится ПОВЕРХ содержимого, а её текст меняется.
test('отлистанный экран узнаётся по плашке возврата вниз', () => {
  assert.strictEqual(S.scrolledBack(
    '│                     ▘▘ ▝▝      Jump to bottom (click) ↓ aude Opus 5 (`claude-opus-5`)… │'), true);
  assert.strictEqual(S.scrolledBack(
    '  ⎿  $ ls -la /Users/evgeniy/WebstormP 1 new message (click) ↓ /node_modules 2>&1'), true);
  assert.strictEqual(S.scrolledBack('  3 new messages ↓'), true);
  assert.strictEqual(S.scrolledBack('  Jump to bottom: fn+↓ to scroll'), true);
  assert.strictEqual(S.scrolledBack('  Jump to bottom (ctrl+b) ↓'), true);
});

test('живой экран отлистанным не считается', () => {
  assert.strictEqual(S.scrolledBack(PERMISSION), false);
  assert.strictEqual(S.scrolledBack('✻ Roosting… (7s · ↓ 75 tokens · thought for 4s)'), false);
  assert.strictEqual(S.scrolledBack('  ◯ Explore  найти вызовы   2m 2s · ↓ 28.4k tokens'), false);
});

// Без стрелки «Jump to bottom» — обычные английские слова, и вкладка замирала бы
// каждый раз, когда агент печатает их на экране (хоть выводя этот самый файл).
test('одна фраза без стрелки экран не морозит', () => {
  assert.strictEqual(S.scrolledBack('чтобы вернуться вниз, Клод рисует Jump to bottom'), false);
  assert.strictEqual(S.scrolledBack('const RE = /(?:Jump to bottom|\\d+ new messages?)/;'), false);
  assert.strictEqual(S.scrolledBack('⏺ Пришло 2 new messages, разбираю'), false);
});

// --- стена лимита -------------------------------------------------------------
// Упёршаяся в лимит вкладка со стороны выглядит как «готов»: ход кончился, хук отчитался.
// Отличить её можно только по сообщению на экране — а время сброса берётся из снимка расхода,
// поэтому часы из текста разбирать не нужно (и часовой пояс угадывать тоже).
test('сообщение о лимите узнаётся в разных формулировках', () => {
  assert.strictEqual(S.limitHit('Claude usage limit reached. Your limit will reset at 3am (Europe/Moscow).'), true);
  assert.strictEqual(S.limitHit('  5-hour limit reached ∙ resets 3am'), true);
  assert.strictEqual(S.limitHit('weekly limit reached'), true);
  assert.strictEqual(S.limitHit('⏺ работаю\n\nYour limit will reset at 9pm'), true);
});

// Предупреждение — не стена: при нём агент прекрасно работает, а разбудить работающую вкладку
// значит перебить её на середине хода.
test('предупреждение о близком лимите стеной не считается', () => {
  assert.strictEqual(S.limitHit('Approaching usage limit — 90% used'), false);
  assert.strictEqual(S.limitHit('Warning: nearing your weekly limit reached soon'), false);
});

// Ловушка регулярки: `|` имеет низший приоритет, и с необязательной приставкой выражение
// читалось как «любая строка со словами limit reached». А `rate limit reached` из чужого вывода
// агент печатает сплошь — и ночь принимала это за стену подписки.
test('чужой «rate limit reached» стеной подписки не считается', () => {
  assert.strictEqual(S.limitHit('Error: rate limit reached, retrying in 2s'), false);
  assert.strictEqual(S.limitHit('limit reached'), false);
  assert.strictEqual(S.limitHit('# если limit reached — повторяем запрос'), false);
});

test('обычный вывод агента за лимит не принимается', () => {
  assert.strictEqual(S.limitHit('⏺ Готово, тесты зелёные'), false);
  assert.strictEqual(S.limitHit('const LIMIT = 90; // предел'), false);
  assert.strictEqual(S.limitHit(''), false);
});


// Настоящие строки Claude Code 2.1.239 — вынуты `strings` из бинарника, а не вспомнены. Это и
// был последний открытый вопрос ночного режима: угадали ли мы формулировку стены.
test('баннеры настоящего Клода узнаются', () => {
  assert.strictEqual(S.limitHit('Usage limit reached · continuing automatically at 3:00 PM · esc to cancel'), true);
  assert.strictEqual(S.limitHit('Usage limit reached · continuing shortly · esc to cancel'), true);
  assert.strictEqual(S.limitHit('Usage limit reached again after you continued · continuing automatically at 7:00 AM'), true);
  assert.strictEqual(S.limitHit('Lower-priority mode ended · you have reached your weekly usage limit'), true);
  assert.strictEqual(S.limitHit("You're out of usage credits. /model to switch models."), true);
  assert.strictEqual(S.limitHit('Your organization is out of usage credits. Contact your admin to add more.'), true);
});

// Слово limit в интерфейсе Клода встречается ещё в десятке мест, и ни одно из них не значит
// «окно подписки кончилось»: контекст, подагенты, бюджет, быстрый режим.
test('чужие потолки Клода за стену подписки не принимаются', () => {
  assert.strictEqual(S.limitHit('Context limit reached'), false);
  assert.strictEqual(S.limitHit('Concurrent subagent limit reached. You can run 5 at once'), false);
  assert.strictEqual(S.limitHit('Subagent nesting limit reached (depth 3)'), false);
  assert.strictEqual(S.limitHit('Budget limit reached ($20.00)'), false);
  assert.strictEqual(S.limitHit('Fast limit reached and temporarily disabled'), false);
  assert.strictEqual(S.limitHit("You've reached your Fable 5 limit"), false);
  assert.strictEqual(S.limitHit('spend limit reached (daily; resets 2026-08-08 00:00 UTC)'), false);
});

// Режим низкого приоритета: строка про сброс есть, а стены нет — агент в эту минуту РАБОТАЕТ.
// Разбудить его значит напечатать «продолжай» в середину живого хода.
test('низкий приоритет со словами про сброс стеной не считается', () => {
  assert.strictEqual(S.limitHit('Continuing now at lower priority until your limit resets at 3:00 PM. Your weekly limit still applies.'), false);
  assert.strictEqual(S.limitHit('Continuing automatically when your limit resets at 3:00 PM'), false);
});

// Разговор О стене — не стена. Этот файл, документация и вывод теста печатаются в те же вкладки.
test('цитата и русская проза за стену не принимаются', () => {
  assert.strictEqual(S.limitHit('⏺ в 2.1.239 баннер звучит как Usage limit reached — проверил strings'), false);
  assert.strictEqual(S.limitHit('  assert.strictEqual(S.limitHit("Usage limit reached"), true);'), false);
  assert.strictEqual(S.limitHit('• Anthropic API: "401", "Invalid API key", "usage limit reached"'), false);
  assert.strictEqual(S.limitHit('Мы читаем экран, потому что usage limit reached виден только там, и это давняя история про то, как ночь ошибалась'), false);
});

// Сброс — обратный случай: окно открылось, и вкладка ждёт одного нажатия. Ночью его некому
// сделать, поэтому отличаем от стены отдельно.
test('сообщение о сбросе лимита узнаётся и стеной не считается', () => {
  assert.strictEqual(S.limitReset('Your usage limit has reset · press enter to continue'), true);
  assert.strictEqual(S.limitHit('Your usage limit has reset · press enter to continue'), false);
  assert.strictEqual(S.limitReset('Usage limit reached · continuing automatically at 3:00 PM'), false);
  assert.strictEqual(S.limitReset(''), false);
});

// --- какому числу верить про заполнение контекста ----------------------------
// Живой случай: человек чистит вкладку, разговор становится новым — а снимок расхода лежит
// по одному на сессию, и приложение продолжает читать файл умершего. Полоска стоит полной на
// чистой вкладке, и следом приходит просьба о перезапуске по проценту, которого больше нет.
const SEC = (ms) => Math.floor(ms / 1000);

test('свежий снимок главнее экрана', () => {
  const now = 1_700_000_000_000;
  assert.strictEqual(S.ctxPick({ snap: { used: 42, at: SEC(now) }, line: 80, now }), 42);
});

test('состарившийся снимок уступает строке с экрана', () => {
  const now = 1_700_000_000_000;
  assert.strictEqual(S.ctxPick({ snap: { used: 66, at: SEC(now - 10 * 60_000) }, line: 3, now }), 3);
});

test('без числа на экране остаётся снимок, даже старый', () => {
  const now = 1_700_000_000_000;
  assert.strictEqual(S.ctxPick({ snap: { used: 66, at: SEC(now - 10 * 60_000) }, line: null, now }), 66);
});

test('без снимка берём экран, а без обоих — ничего', () => {
  assert.strictEqual(S.ctxPick({ snap: null, line: 12, now: 1 }), 12);
  assert.strictEqual(S.ctxPick({ snap: null, line: null, now: 1 }), null);
  assert.strictEqual(S.ctxPick(), null);
});

// Снимок без времени (файл от прежней версии) старым не считаем: иначе он молча перестал бы
// работать вовсе, а он и есть точный источник.
test('снимок без времени остаётся главным', () => {
  assert.strictEqual(S.ctxPick({ snap: { used: 42, at: 0 }, line: 80, now: 1_700_000_000_000 }), 42);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' screen tests passed');
