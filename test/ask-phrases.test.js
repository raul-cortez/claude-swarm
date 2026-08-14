// Plain-node tests for the user-editable «agent is calling me» phrases. This list is
// the ONLY signal separating «готов» from «ждёт ответа» at the end of a turn, and it
// feeds two very different consumers (screen scraping + the Stop hook), so its
// normalisation and matching are pinned here.
const assert = require('assert');
const A = require('../ask-phrases');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const asks = (text, list) => A.asksWith(A.buildAskMatcher(list), text);

test('the default phrase calls the user', () => {
  assert.strictEqual(asks('Готово. Сейчас от тебя: путь к схеме', []), true);
});

test('«ничего, жди …» after the phrase is NOT a call', () => {
  assert.strictEqual(asks('Сейчас от тебя: ничего, жди ревью', []), false);
});

// Живой промах: агент выделяет зов жирным, и в стенограмме (и в тексте, который читает хук)
// стоит `**Сейчас от тебя:** ничего`. На экране разметки нет, поэтому мимо проверки проходила
// ровно та половина каналов, что читает исходный текст, — и «мне ничего не нужно» красило
// вкладку как «ждёт ответа».
test('разметка вокруг фразы не превращает «ничего» в зов', () => {
  assert.strictEqual(asks('**Сейчас от тебя:** ничего, если пуш не нужен — скажешь', []), false);
  assert.strictEqual(asks('*Сейчас от тебя* — ничего, жди результата', []), false);
  assert.strictEqual(asks('**Сейчас от тебя: ничего**, жди', []), false);
  assert.strictEqual(asks('`Сейчас от тебя:` не нужно ничего', []), false);
  // А настоящий зов в разметке зовом и остаётся.
  assert.strictEqual(asks('**Сейчас от тебя:** путь к схеме', []), true);
});

test('no phrase at all is not a call', () => {
  assert.strictEqual(asks('Всё сделал, тесты зелёные.', []), false);
});

test('a custom phrase replaces the default', () => {
  assert.strictEqual(asks('Жду твоего слова', ['Жду твоего слова']), true);
  assert.strictEqual(asks('Сейчас от тебя: путь', ['Жду твоего слова']), false);
});

test('several phrases all work, and the «ничего/жди» rule applies to each', () => {
  const list = ['Сейчас от тебя', 'Жду ответа'];
  assert.strictEqual(asks('Жду ответа по деплою', list), true);
  assert.strictEqual(asks('Жду ответа: ничего, жди', list), false);
});

test('matching ignores case', () => {
  assert.strictEqual(asks('СЕЙЧАС ОТ ТЕБЯ: решение', []), true);
});

test('regex metacharacters in a phrase are literal, not a pattern', () => {
  assert.strictEqual(asks('Твой ход (важно)', ['Твой ход (важно)']), true);
  assert.strictEqual(asks('Твой ход важно', ['Твой ход (важно)']), false, 'must not act as a group');
  assert.doesNotThrow(() => A.buildAskMatcher(['[', '(', '\\']));
});

test('normalize: trims, drops empties, collapses inner spaces', () => {
  assert.deepStrictEqual(A.normalizePhrases(['  Жду   ответа  ', '', '   ']), ['Жду ответа']);
});

test('normalize: de-dupes case-insensitively, keeping the first spelling', () => {
  assert.deepStrictEqual(A.normalizePhrases(['Жду ответа', 'жду ответа']), ['Жду ответа']);
});

test('normalize: empty input falls back to the shipped default', () => {
  assert.deepStrictEqual(A.normalizePhrases([]), A.DEFAULT_ASK_PHRASES);
  assert.deepStrictEqual(A.normalizePhrases(null), A.DEFAULT_ASK_PHRASES);
});

test('normalize: caps the count and the length of one phrase', () => {
  const many = Array.from({ length: A.MAX_PHRASES + 5 }, (_, i) => 'фраза ' + i);
  assert.strictEqual(A.normalizePhrases(many).length, A.MAX_PHRASES);
  assert.strictEqual(A.normalizePhrases(['x'.repeat(A.MAX_LEN + 40)])[0].length, A.MAX_LEN);
});

test('phraseSources are JSON-safe strings the hook can recompile', () => {
  const src = A.phraseSources(['Жду ответа']);
  assert.strictEqual(typeof src.mark, 'string');
  const round = {
    mark: new RegExp(src.mark, 'i'),
    none: new RegExp(src.none, 'i'),
    wait: new RegExp(src.wait, 'i'),
  };
  assert.strictEqual(A.asksWith(round, 'Жду ответа сейчас'), true);
  assert.strictEqual(A.asksWith(round, 'Жду ответа: ничего, жди'), false);
  assert.strictEqual(A.waitsWith(round, 'Жду ответа: ничего, жду сборку'), true);
});

// --- «ничего, жду замер стенда»: от человека ничего, но работа идёт ---------------
// Третий исход конца хода. Он существует, потому что до него вкладка с живой фоновой
// задачей была неотличима от свободной — зелёной, «дай ей работу».

const kind = (text, list) => A.callKind(A.buildAskMatcher(list), text);

test('«ничего, жду …» — работа идёт, но человека не зовут', () => {
  assert.strictEqual(kind('Сейчас от тебя: ничего, жду замер стенда'), 'wait');
  assert.strictEqual(kind('Сейчас от тебя: ничего, ждём сборку'), 'wait');
  assert.strictEqual(kind('Сейчас от тебя: жду ответа фонового агента'), 'wait');
  assert.strictEqual(kind('**Сейчас от тебя:** ничего — жду typecheck'), 'wait');
});

test('повелительное «жди результата» осталось «готов», а не фоном', () => {
  // Одна буква разницы, и она содержательная: ждёт человек — значит агент закончил.
  assert.strictEqual(kind('Сейчас от тебя: ничего, жди результата'), null);
  assert.strictEqual(kind('Сейчас от тебя: ничего'), null);
});

test('«жду» после настоящей просьбы — это зов, а не фон', () => {
  // Между фразой и «жду» стоит сама просьба, значит человеку есть что делать.
  assert.strictEqual(kind('Сейчас от тебя: решение по схеме, жду ответа'), 'ask');
  assert.strictEqual(kind('Сейчас от тебя: путь к схеме'), 'ask');
});

test('решает ПОСЛЕДНЯЯ фраза: на экране висит и прошлый ход', () => {
  const screen = 'Сейчас от тебя: ничего, жду сборку\n…\nСейчас от тебя: ничего';
  assert.strictEqual(kind(screen), null);
  const asked = 'Сейчас от тебя: ничего\n…\nСейчас от тебя: путь к схеме';
  assert.strictEqual(kind(asked), 'ask');
  const started = 'Сейчас от тебя: ничего\n…\nСейчас от тебя: ничего, жду замер';
  assert.strictEqual(kind(started), 'wait');
});

test('без фразы вердикта нет', () => {
  assert.strictEqual(kind('Просто отчёт. Жду сборку.'), null);
});

// --- saysNone: агент сказал прямо, что от человека ничего не нужно ------------------
// Нужно перезапуску: строгая пометка «человек этого не видел» держится до ОТВЕТА человека, а
// отвечать на «от тебя ничего» он не станет — вкладка запирала бы себя (см. unread.onTurnEnd).
// Отличие от `callKind === null` в том, что молчание фразой не считается: ход без подписи ничего
// не сообщает о том, ждут ли ответа, и обращаться с ним надо как с обычным ответом.

const none = (text, list) => A.saysNone(A.buildAskMatcher(list), text);

test('saysNone catches an explicit «ничего»', () => {
  assert.strictEqual(none('Готово. Сейчас от тебя: ничего.', []), true);
  assert.strictEqual(none('Сейчас от тебя: ничего, жду фиксы по базе.', []), true);
  assert.strictEqual(none('Сейчас от тебя: ничего, вкладку можно гасить.', []), true);
});

test('saysNone is false for a real call and for silence', () => {
  assert.strictEqual(none('Сейчас от тебя: путь к схеме.', []), false);
  assert.strictEqual(none('Починил сборку, тесты зелёные.', []), false, 'ход без фразы — не «ничего»');
  assert.strictEqual(none('', []), false);
});

// --- askExcerpt: the text of the question, for the tooltip / notification / bridge --

const excerpt = (text, list, max) => A.askExcerpt(A.buildAskMatcher(list), text, max);

test('excerpt starts at the phrase, dropping the report above it', () => {
  const msg = 'Починил сборку, тесты зелёные.\n\nСейчас от тебя: путь к схеме.';
  assert.strictEqual(excerpt(msg, []), 'Сейчас от тебя: путь к схеме.');
});

test('excerpt flattens newlines so a chip tooltip stays one paragraph', () => {
  const msg = 'Сейчас от тебя:\n- вариант 1\n- вариант 2';
  assert.strictEqual(excerpt(msg, []), 'Сейчас от тебя: - вариант 1 - вариант 2');
});

test('excerpt without a phrase falls back to the tail of the message', () => {
  assert.strictEqual(excerpt('Просто отчёт без фразы.', []), 'Просто отчёт без фразы.');
});

test('excerpt is capped and ellipsised', () => {
  const out = excerpt('Сейчас от тебя: ' + 'ы'.repeat(200), [], 40);
  assert.strictEqual(out.length, 40);
  assert.ok(out.endsWith('…'), out);
});

test('excerpt of nothing is an empty string', () => {
  assert.strictEqual(excerpt('', []), '');
  assert.strictEqual(excerpt(null, []), '');
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' ask-phrases tests passed');
