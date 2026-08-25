// Plain-node tests for reading status off Claude's own .jsonl transcript. Fixtures
// mirror the real shapes seen in ~/.claude/projects/<slug>/<session>.jsonl: message
// lines (assistant/user) interleaved with bookkeeping lines (mode, ai-title, …) and
// with sub-agent lines (isSidechain).
const assert = require('assert');
const T = require('../transcript');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();

const line = (o) => JSON.stringify(o);
const assistant = (content, msAgo = 0, extra = {}) => line(Object.assign({
  type: 'assistant', timestamp: at(msAgo), cwd: '/repo', message: { role: 'assistant', content },
}, extra));
const user = (content, msAgo = 0, extra = {}) => line(Object.assign({
  type: 'user', timestamp: at(msAgo), cwd: '/repo', message: { role: 'user', content },
}, extra));
const NOISE = [
  line({ type: 'mode', mode: 'default', sessionId: 's' }),
  line({ type: 'ai-title', aiTitle: 'что-то', sessionId: 's' }),
  line({ type: 'file-history-snapshot', messageId: 'm' }),
].join('\n');

const asks = (t) => /Сейчас от тебя/.test(t);
const verdict = (text, now = NOW) => T.classify(T.parseEntries(text), now, asks);

test('a running tool → работает', () => {
  const v = verdict([NOISE, assistant([{ type: 'tool_use', name: 'Bash', input: {} }], 200)].join('\n'));
  assert.strictEqual(v.status, 'running');
  assert.strictEqual(v.why, 'tool_use');
});

test('a tool result → работает (the model is thinking)', () => {
  const v = verdict(user([{ type: 'tool_result', content: 'ok' }], 3000));
  assert.strictEqual(v.status, 'running');
});

test('your own prompt → работает', () => {
  const v = verdict(user('почини тесты', 5000));
  assert.strictEqual(v.status, 'running');
});

test('a fresh assistant text is still работает (the turn may continue)', () => {
  const v = verdict(assistant([{ type: 'text', text: 'Сделал первую часть.' }], 300));
  assert.strictEqual(v.status, 'running');
  assert.strictEqual(v.why, 'text (fresh)');
});

test('a quiet assistant text → готов', () => {
  const v = verdict(assistant([{ type: 'text', text: 'Готово, тесты зелёные.' }], T.READY_DEBOUNCE_MS + 500));
  assert.strictEqual(v.status, 'ready');
});

test('a quiet assistant text WITH a call phrase → ждёт: вопрос', () => {
  const v = verdict(assistant([{ type: 'text', text: 'Сейчас от тебя: путь к схеме' }], 5000));
  assert.strictEqual(v.status, 'waiting');
  assert.strictEqual(v.kind, 'question');
});

test('a quiet assistant text WITH the done tag → готов + отметка «работа сдана»', () => {
  // Канал стенограммы — главный источник этой отметки: там текст хода лежит целиком, а не
  // тем куском, что уцелел на экране. Проверяем и ЛОВУШКУ порядка: 'done' истинно, и без
  // своей ветки такой ход уехал бы в «ждёт ответа» по общему `if (call)`.
  const A = require('../ask-phrases');
  const m = A.buildAskMatcher(A.DEFAULT_ASK_PHRASES);
  const v = T.classify(T.parseEntries(assistant([{ type: 'text', text: '[swarm:готово]\nСдал работу.' }], 5000)),
    NOW, (t) => A.callKind(m, t));
  assert.strictEqual(v.status, 'ready');
  assert.strictEqual(v.done, true);
  assert.strictEqual(v.why, 'text + done tag');
});

test('обычный тихий ход отметки «работа сдана» не ставит', () => {
  const v = verdict(assistant([{ type: 'text', text: 'Сделал шаг, иду дальше.' }], 5000));
  assert.strictEqual(v.status, 'ready');
  assert.ok(!v.done);
});

test('thinking-only entries never read as a finished turn text', () => {
  const v = verdict(assistant([{ type: 'thinking', thinking: 'Сейчас от тебя: путь' }], 5000));
  assert.strictEqual(v.status, 'ready', 'thinking is invisible to the user, so it cannot call them');
  assert.strictEqual(T.entryText(JSON.parse(assistant([{ type: 'thinking', thinking: 'x' }]))), '');
});

test('sub-agent lines never drive the tab: the main thread decides', () => {
  const text = [
    assistant([{ type: 'tool_use', name: 'Task', input: {} }], 9000),
    assistant([{ type: 'text', text: 'подагент закончил' }], 100, { isSidechain: true }),
  ].join('\n');
  const v = verdict(text);
  assert.strictEqual(v.status, 'running');
  assert.strictEqual(v.why, 'tool_use', 'the sidechain text must not end the turn');
});

test('bookkeeping lines are skipped entirely', () => {
  assert.deepStrictEqual(T.parseEntries(NOISE), []);
  assert.strictEqual(T.classify(T.parseEntries(NOISE), NOW, asks), null);
});

test('a truncated first line (tail read) is skipped, not fatal', () => {
  const chopped = '{"type":"assist' + '\n' + assistant([{ type: 'text', text: 'ок' }], 5000);
  const v = verdict(chopped);
  assert.strictEqual(v.status, 'ready');
});

test('string content counts as text', () => {
  const v = verdict(assistant('Сейчас от тебя: ответь', 5000));
  assert.strictEqual(v.status, 'waiting');
});

test('cwdOf reads the folder the session belongs to', () => {
  assert.strictEqual(T.cwdOf(T.parseEntries(assistant([{ type: 'text', text: 'x' }]))), '/repo');
  assert.strictEqual(T.cwdOf([]), null);
});

test('projectSlug flattens the path the way Claude names its folders', () => {
  assert.strictEqual(T.projectSlug('/Users/e/WebstormProjects/claude-swarm-lite'),
    '-Users-e-WebstormProjects-claude-swarm-lite');
  assert.strictEqual(T.projectSlug('/Users/e/.config/app'), '-Users-e--config-app');
});

// Windows: the drive colon counts too. Without it the slug is `C:-Users-me-p` while Claude
// writes `C--Users-me-p`, so the transcript channel looks in a folder that never exists.
test('projectSlug flattens a Windows path with a drive letter', () => {
  assert.strictEqual(T.projectSlug('C:\\Users\\me\\WebstormProjects\\swarm'),
    'C--Users-me-WebstormProjects-swarm');
  assert.strictEqual(T.projectSlug('D:\\work\\my.app'), 'D--work-my-app');
});

// Конфиг Клода у вкладки не обязательно ~/.claude: `CLAUDE_CONFIG_DIR` (у человека алиас
// `claude-my`) уводит и разговоры, и настройки в другую папку. Приложение складывало путь из
// зашитого ~/.claude и файла такой вкладки не находило никогда — в телегу вместо ответа агента
// уезжал соскоб с экрана, а при перезапуске вкладка открывалась пустой, потому что её разговор
// считался мёртвым. Корень виден из самого адреса, который сообщает хук.
test('homeOfTranscript достаёт конфиг из адреса стенограммы', () => {
  assert.strictEqual(
    T.homeOfTranscript('/Users/e/.claude-my/projects/-Users-e-proj/abc.jsonl'),
    '/Users/e/.claude-my');
  assert.strictEqual(
    T.homeOfTranscript('/Users/e/.claude/projects/-Users-e-proj/abc.jsonl'),
    '/Users/e/.claude');
  assert.strictEqual(
    T.homeOfTranscript('C:\\Users\\me\\.claude\\projects\\C--Users-me-p\\abc.jsonl'),
    'C:/Users/me/.claude');
});

// А на непохожем адресе — пусто, и зовущий остаётся с домашним конфигом. Молча взять
// «родителя родителя» было бы хуже: приложение искало бы разговоры в случайной папке.
test('homeOfTranscript молчит там, где адрес не похож на стенограмму', () => {
  assert.strictEqual(T.homeOfTranscript('/tmp/abc.jsonl'), '');
  assert.strictEqual(T.homeOfTranscript('/Users/e/.claude/projects/abc.jsonl'), '');
  assert.strictEqual(T.homeOfTranscript(''), '');
  assert.strictEqual(T.homeOfTranscript(null), '');
});

// --- pickBinding: which file belongs to this tab ------------------------------

const OPEN = 100_000;   // when the tab opened
const cand = (over) => Object.assign({ file: 'a.jsonl', mtimeMs: OPEN + 500, cwdInside: '/repo' }, over);
const pick = (cands, over) => T.pickBinding(cands, Object.assign({ startedAt: OPEN, cwd: '/repo' }, over));

test('pickBinding takes the one fresh file recording this cwd', () => {
  assert.strictEqual(pick([cand({ file: 'mine.jsonl' })]), 'mine.jsonl');
});

test('pickBinding ignores a file untouched since the tab opened', () => {
  assert.strictEqual(pick([cand({ mtimeMs: OPEN - 60_000 })]), null);
});

test('pickBinding tolerates a little clock jitter around the tab start', () => {
  assert.strictEqual(pick([cand({ mtimeMs: OPEN - 1000 })]), 'a.jsonl');
});

test('pickBinding ignores a file whose recorded cwd is another folder', () => {
  assert.strictEqual(pick([cand({ cwdInside: '/other' })]), null);
  assert.strictEqual(pick([cand({ cwdInside: null })]), null, 'unreadable is not a match');
});

test('pickBinding skips a file already bound to another tab', () => {
  assert.strictEqual(pick([cand({ file: 'taken.jsonl' })], { taken: new Set(['taken.jsonl']) }), null);
});

test('pickBinding binds NOTHING when two files qualify (never guess between tabs)', () => {
  assert.strictEqual(pick([cand({ file: 'a.jsonl' }), cand({ file: 'b.jsonl' })]), null);
});

test('pickBinding survives junk input', () => {
  assert.strictEqual(pick([]), null);
  assert.strictEqual(pick(null), null);
  assert.strictEqual(pick([null, cand()]), 'a.jsonl');
  assert.strictEqual(T.pickBinding([cand()], null), null, 'no cwd to match against');
});

// --- pickByScreen: telling two tabs in one folder apart -----------------------

const sc = (over) => Object.assign({ file: 'a.jsonl', text: '' }, over);
const LONG = 'Починил сборку, тесты зелёные, дифф оставил незакоммиченным для ревью';

test('pickByScreen finds the transcript whose last message is on this screen', () => {
  const cands = [sc({ file: 'mine.jsonl', text: LONG }), sc({ file: 'other.jsonl', text: 'Совсем другой текст про совсем другую задачу целиком' })];
  // The terminal wraps the same sentence differently — the match must survive that.
  const snap = 'Починил сборку, тесты зелёные, дифф оставил\nнезакоммиченным для ревью\n> ';
  assert.strictEqual(T.pickByScreen(cands, snap), 'mine.jsonl');
});

test('pickByScreen refuses when two candidates match', () => {
  const cands = [sc({ file: 'a.jsonl', text: LONG }), sc({ file: 'b.jsonl', text: LONG })];
  assert.strictEqual(T.pickByScreen(cands, LONG), null);
});

test('pickByScreen refuses when nothing matches, or there is too little to go on', () => {
  assert.strictEqual(T.pickByScreen([sc({ text: LONG })], 'пустой экран > '), null);
  assert.strictEqual(T.pickByScreen([sc({ text: 'коротко' })], LONG), null, 'short text proves nothing');
  assert.strictEqual(T.pickByScreen([], LONG), null);
});

test('screenKey ignores whitespace, case and punctuation', () => {
  assert.strictEqual(T.screenKey('Готово!  Тесты — зелёные.'), T.screenKey('готово тесты\nзелёные'));
});

// --- привязка по тексту, который напечатал мост -------------------------------
// Живой случай: три вкладки на одной папке, все разговоры свежие, ни один не выигрывает
// по однозначности — вкладка осталась без стенограммы, и в телегу уехало «✅ готов» без
// текста ответа. Но мост ЗНАЕТ, что напечатал, и метка [тлг] есть только в его репликах.

const injected = '[тлг: отвечай коротко] Посмотри, почему падает тест на миграциях';

test('pickByInjected находит файл по дословному тексту из телеги', () => {
  const cands = [
    { file: 'other.jsonl', userText: 'привет\nсделай рефакторинг' },
    { file: 'mine.jsonl', userText: 'старое сообщение\n' + injected },
  ];
  assert.strictEqual(T.pickByInjected(cands, injected), 'mine.jsonl');
});

test('pickByInjected молчит, когда текста нет ни в одном файле', () => {
  const cands = [{ file: 'a.jsonl', userText: 'привет' }, { file: 'b.jsonl', userText: 'ага' }];
  assert.strictEqual(T.pickByInjected(cands, injected), null);
});

// Короткий ключ ничего не доказывает: «да» встречается в любом разговоре, и привязка по
// нему увела бы статус одного агента на вкладку другого.
test('pickByInjected не верит короткому совпадению', () => {
  const cands = [{ file: 'a.jsonl', userText: 'да, вариант 2' }];
  assert.strictEqual(T.pickByInjected(cands, 'да'), null);
  assert.strictEqual(T.pickByInjected(cands, ''), null);
  assert.strictEqual(T.pickByInjected(cands, null), null);
});

test('pickByInjected отказывается при двух совпадениях, как остальные ключи', () => {
  const cands = [
    { file: 'a.jsonl', userText: injected },
    { file: 'b.jsonl', userText: injected },
  ];
  assert.strictEqual(T.pickByInjected(cands, injected), null);
});

// --- текст этого хода или прошлого -------------------------------------------
// Живая беда: статус «готов» приходит от хука Stop сразу, а classify до конца своего отстоя
// (READY_DEBOUNCE_MS) держит «работает» и текст НЕ обновляет. Значит в момент, когда мост
// решает докладывать, свежего текста ещё нет — а прошлый есть и выглядит нормально. В чат
// уезжал ответ не на ту задачу.

test('belongsToTurn: текст, записанный после начала хода, принадлежит ходу', () => {
  const turnStarted = 1000;
  assert.strictEqual(T.belongsToTurn(1200, turnStarted), true);
  assert.strictEqual(T.belongsToTurn(1000, turnStarted), true, 'ровно в начало — уже этот ход');
});

test('belongsToTurn: текст прошлого хода не сойдёт за итог нового', () => {
  assert.strictEqual(T.belongsToTurn(900, 1000), false);
});

test('belongsToTurn: пустые значения не притворяются свежим текстом', () => {
  assert.strictEqual(T.belongsToTurn(0, 1000), false, 'текста ещё не было');
  assert.strictEqual(T.belongsToTurn(null, 1000), false);
  assert.strictEqual(T.belongsToTurn(undefined, 1000), false);
});

// Ход ещё не начинался (вкладка только что открыта, приложение только что запущено): тогда
// сравнивать не с чем, и текст стенограммы — единственное, что есть. Отказываться от него
// незачем: он про то, что в этой вкладке и происходило.
test('belongsToTurn: без известного начала хода текст годится', () => {
  assert.strictEqual(T.belongsToTurn(1200, 0), true);
  assert.strictEqual(T.belongsToTurn(1200, null), true);
});

// --- весь ход, а не последняя фраза ------------------------------------------
// Ход у Клода разорван инструментами, и в стенограмме это отдельные записи. В телегу
// уезжала лишь последняя — то есть огрызок ответа.
const TURN = T.parseEntries([
  assistant([{ type: 'text', text: 'Старый ход, он остался позади.' }], 9000),
  user('почини сборку', 8000),
  assistant([{ type: 'text', text: 'Сейчас посмотрю, что в сборке.' }], 7000),
  assistant([{ type: 'tool_use', name: 'Bash', input: {} }], 6000),
  user([{ type: 'tool_result', content: 'ошибка' }], 5000),
  assistant([{ type: 'text', text: 'Подагент сходил за своим' }], 4000, { isSidechain: true }),
  assistant([{ type: 'thinking', thinking: 'вслух не говорю' }], 3000),
  assistant([{ type: 'text', text: 'Нашёл: падал тест. Починил.' }], 2000),
].join('\n'));

test('turnText собирает всё, что агент сказал за ход', () => {
  assert.strictEqual(T.turnText(TURN),
    'Сейчас посмотрю, что в сборке.\n\nНашёл: падал тест. Починил.');
});

test('turnText не выходит за реплику человека и не берёт подагентов и мысли', () => {
  const got = T.turnText(TURN);
  assert.ok(!/Старый ход/.test(got), 'прошлый ход — не этот');
  assert.ok(!/почини сборку/.test(got), 'слова человека — не ответ агента');
  assert.ok(!/Подагент/.test(got), 'подагент говорит не за вкладку');
  assert.ok(!/вслух не говорю/.test(got), 'мысли человек не видит');
});

// --- признаки жизни: чем занят и сколько написал ------------------------------
// С телефона «получил, думаю…» без чисел не отличает работающего агента от уснувшего мака.
// Оба числа берутся из уже разобранных записей — своей работы это не стоит.

test('currentTool называет инструмент, пока результат не пришёл', () => {
  const running = T.parseEntries([
    user('почини сборку', 8000),
    assistant([{ type: 'tool_use', name: 'Bash', input: {} }], 6000),
  ].join('\n'));
  assert.strictEqual(T.currentTool(running), 'Bash');
  // Результат пришёл — инструмент отработал, дальше думает модель, и имени у этого нет.
  assert.strictEqual(T.currentTool(TURN), null);
  assert.strictEqual(T.currentTool([]), null);
  assert.strictEqual(T.currentTool(null), null);
});

test('turnTokens считает расход ЭТОГО хода, а не всей сессии', () => {
  const usage = (out, read) => ({
    message: { usage: { output_tokens: out, cache_read_input_tokens: read, input_tokens: 2 } },
  });
  const entries = T.parseEntries([
    assistant([{ type: 'text', text: 'прошлый ход' }], 9000, usage(9999, 9999)),
    user('почини сборку', 8000),
    assistant([{ type: 'text', text: 'смотрю' }], 7000, usage(100, 1000)),
    user([{ type: 'tool_result', content: 'ошибка' }], 6000),
    assistant([{ type: 'text', text: 'починил' }], 5000, usage(50, 2000)),
  ].join('\n'));
  const got = T.turnTokens(entries);
  assert.strictEqual(got.out, 150, 'сложились только записи после реплики человека');
  assert.strictEqual(got.inp, 3004, 'вход — свежий плюс кэш');
  assert.deepStrictEqual(T.turnTokens([]), { out: 0, inp: 0 });
});

// Ответ инструмента приходит записью того же типа, что и реплика человека. Принять его за
// границу — значит обрезать ход по первому же инструменту, то есть вернуть тот же огрызок.
test('turnText: результат инструмента ход не заканчивает', () => {
  assert.ok(/Сейчас посмотрю/.test(T.turnText(TURN)));
});

// Не влезло — выпадает раннее повествование, а вывод остаётся целиком: его и читают.
test('turnText: предел режет начало, а не итог', () => {
  const got = T.turnText(TURN, 40);
  assert.ok(got.length <= 44, got);
  assert.ok(got.startsWith('…'), got);
  assert.ok(/Нашёл: падал тест\. Починил\./.test(got), got);
});

test('turnText: одно длинное сообщение читают сверху, поэтому режется хвост', () => {
  const one = T.parseEntries(assistant([{ type: 'text', text: 'а'.repeat(50) }], 1000));
  const got = T.turnText(one, 20);
  assert.strictEqual(got.length, 20);
  assert.ok(got.endsWith('…'));
});

// Настройка подробности — просьба к агенту отвечать короче, а НЕ ножницы по готовому
// ответу. Поэтому мост зовёт turnText без предела, и предел не должен появиться «по
// умолчанию»: обрезать сказанное значит решить за человека, какая часть ему не нужна.
test('turnText без предела не режет ничего', () => {
  const long = 'я'.repeat(30_000);
  const one = T.parseEntries(assistant([{ type: 'text', text: long }], 1000));
  assert.strictEqual(T.turnText(one), long);
});

test('turnText: без записей — пустая строка, а не «undefined»', () => {
  assert.strictEqual(T.turnText([]), '');
  assert.strictEqual(T.turnText(null), '');
});

// --- Esc: ход оборван ---------------------------------------------------------
// Живая беда: оборвёшь агента на полуслове — вкладка навсегда остаётся «работает». По форме
// прерывание — реплика человека, и classify отвечал «работает (prompt)», то есть «сейчас
// начнёт». Начинать нечего: следующая запись в файле появится только когда человек сам
// заговорит, а до тех пор из «работает» вкладку не выводит ничто.
const INTERRUPT = '[Request interrupted by user]';
const INTERRUPT_TOOL = '[Request interrupted by user for tool use]';

test('прерывание на полуслове → готов, а не вечное «работает»', () => {
  const v = verdict([
    assistant([{ type: 'text', text: 'Сейчас посмотрю' }], 3000),
    user([{ type: 'text', text: INTERRUPT }], 2000),
  ].join('\n'));
  assert.strictEqual(v.status, 'ready');
  assert.strictEqual(v.why, 'interrupted');
});

// Рубанули по живому инструменту — формулировка другая, смысл тот же.
test('прерывание на инструменте → готов', () => {
  const v = verdict([
    assistant([{ type: 'tool_use', name: 'Bash', input: {} }], 3000),
    user([{ type: 'text', text: INTERRUPT_TOOL }], 2000),
  ].join('\n'));
  assert.strictEqual(v.status, 'ready');
  assert.strictEqual(v.why, 'interrupted');
});

// Отстоя тут быть не должно: ждут его ради продолжения хода, а продолжение уже отменено.
test('прерывание не ждёт отстоя: готов сразу', () => {
  const v = verdict(user([{ type: 'text', text: INTERRUPT }], 0));
  assert.strictEqual(v.status, 'ready');
});

test('обычная реплика человека по-прежнему «работает»', () => {
  assert.strictEqual(verdict(user('а теперь оборви и переделай', 2000)).status, 'running');
  assert.strictEqual(verdict(user('почему тут [Request interrupted by user]?', 2000)).status,
    'running', 'разговор ПРО прерывание — не прерывание');
});

// Ход оборван, но агент до Esc успел сказать главное. Считать прерывание границей хода
// значит отправить в телегу «готов» вообще без текста — при том что текст есть.
test('turnText: прерывание ход не заканчивает, сказанное до Esc остаётся', () => {
  const e = T.parseEntries([
    user('почини сборку', 8000),
    assistant([{ type: 'text', text: 'Сейчас посмотрю, что в сборке.' }], 7000),
    assistant([{ type: 'tool_use', name: 'Bash', input: {} }], 6000),
    user([{ type: 'text', text: INTERRUPT_TOOL }], 5000),
  ].join('\n'));
  assert.strictEqual(T.turnText(e), 'Сейчас посмотрю, что в сборке.');
});

// Живой случай (вкладка bnmap-lk, 0.26.1): в стенограмме два промпта человека и ни одного
// ответа — агента закрыли посреди хода. classify честно говорит «работает», и после
// перезапуска вкладка висела жёлтой вечно: дописывать этот ход уже некому.
test('isPastLife: разговор, оборванный до перезапуска вкладки', () => {
  const e = T.parseEntries([user('сделай раз', 40000), user('и ещё два', 30000)].join('\n'));
  assert.strictEqual(T.classify(e, NOW, asks).status, 'running', 'сам вердикт не меняем');
  // Вкладка открыта ПОСЛЕ этих записей — значит они из прошлой жизни.
  assert.strictEqual(T.isPastLife(e, NOW - 10000), true);
  // Та же вкладка, но записи появились уже при её жизни — обычная работа.
  assert.strictEqual(T.isPastLife(e, NOW - 60000), false);
});

test('isPastLife молчит, когда сравнивать не с чем', () => {
  const e = T.parseEntries(user('привет', 1000));
  assert.strictEqual(T.isPastLife(e, 0), false, 'вкладка без времени старта');
  assert.strictEqual(T.isPastLife([], NOW), false, 'пустая стенограмма');
  assert.strictEqual(T.isPastLife(null, NOW), false);
});

test('isInterrupt узнаёт только сам маркер', () => {
  const mk = (c) => JSON.parse(user(c));
  assert.strictEqual(T.isInterrupt(mk([{ type: 'text', text: INTERRUPT }])), true);
  assert.strictEqual(T.isInterrupt(mk(INTERRUPT_TOOL)), true, 'строкой — тот же маркер');
  assert.strictEqual(T.isInterrupt(mk('  ' + INTERRUPT + '\n')), true, 'пробелы вокруг не мешают');
  assert.strictEqual(T.isInterrupt(mk('сначала ' + INTERRUPT + ', потом переделай')), false);
  assert.strictEqual(T.isInterrupt(JSON.parse(assistant([{ type: 'text', text: INTERRUPT }]))), false);
  assert.strictEqual(T.isInterrupt(null), false);
});

// Отстой classify — это НЕ таймер моста, а причина, по которой мост обязан подождать. Пусть
// связь между ними будет видна: если отстой станет нулём, ждать было бы нечего.
test('READY_DEBOUNCE_MS — не ноль, иначе и ждать текст незачем', () => {
  assert.ok(T.READY_DEBOUNCE_MS > 0);
});

// --- ход кончился, а работа нет ------------------------------------------------
// Стенограмма видит тихий текст агента и в этом случае, и когда всё сделано: записи
// одинаковые. Разделяет их слово самого агента, поэтому classify спрашивает `asks`.

const kinded = (text, kind) => T.classify(T.parseEntries(text), NOW, () => kind);

test('фраза «жду» превращает конец хода в «работает в фоне»', () => {
  const v = kinded(assistant([{ type: 'text', text: 'Сейчас от тебя: ничего, жду замер' }], 5000), 'wait');
  assert.strictEqual(v.status, 'running');
  assert.strictEqual(v.bg, true);
  assert.strictEqual(v.why, 'text + wait phrase');
  assert.ok(v.text.includes('жду замер'), 'текст хода нужен мосту');
});

test('зов остаётся зовом, а молчание — «готов»', () => {
  const ask = kinded(assistant([{ type: 'text', text: 'Сейчас от тебя: путь' }], 5000), 'ask');
  assert.strictEqual(ask.status, 'waiting');
  assert.strictEqual(ask.kind, 'question');
  assert.ok(!ask.bg);
  const done = kinded(assistant([{ type: 'text', text: 'Готово.' }], 5000), null);
  assert.strictEqual(done.status, 'ready');
});

test('старый вызов с булевым `asks` продолжает работать', () => {
  // main.js когда-то передавал сюда предикат «зовёт ли»; ломать его на ровном месте
  // значило бы получить «готов» вместо «ждёт» в сборке, где обновилась половина файлов.
  const v = kinded(assistant([{ type: 'text', text: 'Сейчас от тебя: путь' }], 5000), true);
  assert.strictEqual(v.status, 'waiting');
  assert.strictEqual(v.kind, 'question');
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' transcript tests passed');
