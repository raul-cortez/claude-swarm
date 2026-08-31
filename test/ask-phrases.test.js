// Plain-node tests for the «agent is calling me» markers. Это ЕДИНСТВЕННЫЙ признак,
// отличающий «готов» от «ждёт ответа» в конце хода, и его читают два очень разных
// потребителя (скрёб экрана и хук на Stop), поэтому разбор прибит здесь.
//
// Два канала: ТЕГИ ([swarm:вопрос] / [swarm:фон]) — основной, им учит правило; ФРАЗЫ — путь
// совместимости для тех, у кого подпись уже лежит в своём CLAUDE.md и в привычках.
const assert = require('assert');
const A = require('../ask-phrases');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const asks = (text, list) => A.asksWith(A.buildAskMatcher(list), text);
const waits = (text, list) => A.waitsWith(A.buildAskMatcher(list), text || '');
const kind = (text, list) => A.callKind(A.buildAskMatcher(list), text);

// --- теги ---------------------------------------------------------------------

test('тег зова — это зов, на обоих языках и в любом регистре', () => {
  for (const t of ['[swarm:вопрос]\nЧто ставим?', '[swarm:question]\nWhich one?',
    '[ SWARM : ВОПРОС ]\nНу?', '[Swarm:Question]\nSo?']) {
    assert.strictEqual(asks(t, []), true, t);
  }
});

test('тег фона — работа идёт, человек не нужен', () => {
  for (const t of ['[swarm:фон]\nЗапустил замер.', '[swarm:background]\nStarted the build.',
    '[ Swarm : Фон ]\nЖду.']) {
    assert.strictEqual(kind(t, []), 'wait', t);
    assert.strictEqual(asks(t, []), false, t);
  }
});

// --- тег КОНЦА РАБОТЫ ------------------------------------------------------------
// Третья метка отвечает не на «ждут ли меня», а на «кончилась ли вся задача». Нужна она
// вкладке с мандатом «работай без меня»: та крашена целиком, и молчание между ходами в ней
// выглядит так же, как сданная работа.

test('тег конца работы — не зов и не фон, а свой третий вид', () => {
  for (const t of ['[swarm:готово]\nСделал всё, итог такой.', '[swarm:done]\nAll done.',
    '[ Swarm : Готово ]\nИтог.']) {
    assert.strictEqual(kind(t, []), 'done', t);
    assert.strictEqual(asks(t, []), false, t);
    assert.strictEqual(waits(t, []), false, t);
    assert.strictEqual(A.saysDone(A.buildAskMatcher([]), t), true, t);
  }
});

test('тег конца работы не читается как зов по остаточному правилу', () => {
  // Ловушка, ради которой тест и стоит: разбор кончается правилом «метка есть, хвост не
  // „ничего“ — значит зов». Не проверь мы тег конца работы среди тегов, сдавшая работу
  // вкладка красилась бы «ждёт ответа» — то есть новая метка ломала бы статус.
  const m = A.buildAskMatcher(['Сейчас от тебя']);
  assert.strictEqual(A.callKind(m, '[swarm:готово]\nСделал. Итог: три файла, тесты зелёные.'), 'done');
  assert.strictEqual(A.asksWith(m, '[swarm:готово]\nСделал. Итог: три файла, тесты зелёные.'), false);
});

test('последняя метка решает и здесь: вопрос после итога — это вопрос', () => {
  assert.strictEqual(kind('[swarm:готово]\nСдал.\n\n[swarm:вопрос]\nА релиз делать?', []), 'ask');
  assert.strictEqual(kind('[swarm:вопрос]\nЧто ставим?\n\n[swarm:готово]\nЛадно, решил сам. Сдал.', []),
    'done');
});

test('тег конца работы вычищается из выжимки, как и остальные', () => {
  const m = A.buildAskMatcher([]);
  assert.ok(!A.askExcerpt(m, '[swarm:готово]\nСделал всё.').includes('['));
});

// --- МЕСТО тега: с начала строки, и только оттуда --------------------------------
// Причина, по которой место вообще проверяется: агент, который ПИШЕТ про сам протокол — в доке,
// в отчёте, в эстафете соседу, — называет метку в своём тексте. Пока меткой считалось любое
// вхождение, такой агент звал человека нечаянно, и вкладка горела оранжевым на ровном месте.

test('тег внутри фразы ничего не значит: про протокол можно писать спокойно', () => {
  assert.strictEqual(kind('Правило такое: тег [swarm:вопрос] в начале строки — это зов.', []), null);
  assert.strictEqual(kind('Раньше меткой было любое [swarm:вопрос], теперь нет.', []), null);
  assert.strictEqual(kind('- [swarm:фон] — значит работа идёт сама', []), null, 'пункт списка — не начало');
  assert.strictEqual(kind('Отчёт готов.\n\nЧто ставим? [swarm:вопрос]', []), null,
    'в конце строки после текста — уже не метка');
});

test('тег считается с начала ЛЮБОЙ строки, не только первой', () => {
  // Учим ставить в начале сообщения, но понимаем и в конце: экран видит переписку целиком,
  // границ сообщения в нём нет, и лишняя терпимость тут бесплатна.
  assert.strictEqual(kind('[swarm:вопрос]\n\nСобрал стенд. Что ставим?', []), 'ask');
  assert.strictEqual(kind('Собрал стенд. Что ставим?\n\n[swarm:вопрос]', []), 'ask');
  assert.strictEqual(kind('[swarm:вопрос] Что ставим?', []), 'ask', 'текст в той же строке зов не убивает');
  assert.strictEqual(kind('  [swarm:фон]\nСобираю.', []), 'wait', 'отступ не мешает');
});

test('разметка вокруг тега его не скрывает', () => {
  // Агент выделяет метку жирным или кодом. Экран разметки не видит, а стенограмма и хук читают
  // исходный текст — без этой поправки тег терялся бы ровно у половины каналов.
  for (const t of ['**[swarm:вопрос]**\nЧто ставим?', '`[swarm:вопрос]`\nЧто ставим?',
    '*[swarm:вопрос]*\nЧто ставим?', '__[swarm:вопрос]__\nЧто ставим?']) {
    assert.strictEqual(kind(t, []), 'ask', t);
  }
});

test('короткая форма без приставки ещё понимается', () => {
  // Её агенты уже могли выучить из чужих CLAUDE.md и старых эстафет, и молча перестать её
  // узнавать — значит потерять зов. Путаницы от неё нет: за это отвечает начало строки.
  assert.strictEqual(kind('[вопрос]\nЧто ставим?', []), 'ask');
  assert.strictEqual(kind('[фон]\nСобираю.', []), 'wait');
  assert.strictEqual(kind('тег [вопрос] в середине строки — не метка', []), null);
});

test('без тега и без фразы ход означает «готов»', () => {
  assert.strictEqual(kind('Готово: три файла, тесты зелёные.', []), null);
  assert.strictEqual(kind('Собрал стенд, отчёт выше.', []), null);
});

// Хвост считается от ПОСЛЕДНЕЙ метки: экран — это переписка целиком, и над свежим ходом
// висит позапрошлый. Тег из прошлого хода не должен отвечать за нынешний.
test('последняя метка побеждает, тег или фраза', () => {
  assert.strictEqual(kind('[swarm:вопрос]\nЧто ставим?\n\nГотово. Сейчас от тебя: ничего', []), null);
  assert.strictEqual(kind('Сейчас от тебя: ничего\n\n[swarm:вопрос]\nА теперь что ставим?', []), 'ask');
  assert.strictEqual(kind('[swarm:фон]\nСобираю.\n\n[swarm:вопрос]\nЧто ставим?', []), 'ask');
  assert.strictEqual(kind('[swarm:вопрос]\nЧто ставим?\n\n[swarm:фон]\nЛадно, сам. Собираю.', []), 'wait');
});

test('тег работает при любом списке фраз: он протокол, а не настройка', () => {
  for (const list of [[], ['Твой ход'], ['Now from you', 'Твой ход']]) {
    assert.strictEqual(asks('[swarm:вопрос]\nЧто ставим?', list), true, JSON.stringify(list));
    assert.strictEqual(waits('[swarm:фон]\nСобираю.', list), true, JSON.stringify(list));
  }
});

test('похожее на тег, но не тег', () => {
  // Скобки в обычном тексте встречаются: ссылки, сноски, примеры кода. Метка — отдельное
  // слово в скобках с начала строки, и совпадать должна именно она.
  assert.strictEqual(asks('см. массив items[swarm:вопрос] в коде', []), false);
  assert.strictEqual(asks('вопрос без скобок ничего не значит', []), false);
  assert.strictEqual(asks('[swarm:вопросы]\nв множественном числе — не метка', []), false);
  assert.strictEqual(asks('[вопрос:swarm]\nприставка не с той стороны', []), false);
});

test('выжимка не тащит тег в подсказку и уведомление', () => {
  const m = A.buildAskMatcher([]);
  assert.strictEqual(A.askExcerpt(m, '[swarm:вопрос]\nСобрал стенд.\nЧто ставим: заливку или точку?'),
    'Собрал стенд. Что ставим: заливку или точку?');
  assert.ok(!A.askExcerpt(m, '[swarm:фон]\nЖду сборку.').includes('['));
});

// Тег сверху — это ещё не вопрос: он только говорит «я жду». Сам вопрос агент дописывает
// последним абзацем, поэтому в уведомление должен уехать КОНЕЦ сообщения, а не начало отчёта.
test('выжимка при теге берёт конец сообщения, а не начало отчёта', () => {
  const m = A.buildAskMatcher([]);
  const msg = '[swarm:вопрос]\n\n' + 'Разобрал журнал, дыра одна. '.repeat(20) + '\n\nЧто ставим?';
  const out = A.askExcerpt(m, msg, 60);
  assert.ok(out.endsWith('Что ставим?'), out);
  assert.ok(out.startsWith('…'), out);
  assert.ok(out.length <= 60, out.length);
});

test('«от тебя ничего» — и тег фона тоже это говорит', () => {
  const m = A.buildAskMatcher([]);
  assert.strictEqual(A.saysNone(m, '[swarm:фон]\nСобираю.'), true);
  assert.strictEqual(A.saysNone(m, '[swarm:вопрос]\nЧто ставим?'), false);
  assert.strictEqual(A.saysNone(m, 'Готово.'), false, 'молчание подписью не считается');
});

// --- фразы: путь совместимости -------------------------------------------------

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
