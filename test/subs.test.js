// Тесты подписок (subs.js). Под тестом ровно то, что нельзя проверить глазами в приложении:
// миграция прежнего списка запуска (потеряем — человек откроет вкладки не тем агентом),
// сопоставление карточки с аккаунтом (перепутаем — покажем расход чужой подписки под своим
// именем) и «нет чисел ⇒ нет пилюли» (ноль вместо неизвестного — вранье о расходе).
const assert = require('assert');
const subs = require('../subs');
const statusline = require('../swarm-statusline');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const NOW = 1_700_000_000_000;           // мс
const SEC = Math.floor(NOW / 1000);

const acc = (home, five, seven, lines) => ({
  home,
  five: five == null ? null : { spent: five, resetsAt: SEC + 3600 },
  seven: seven == null ? null : { spent: seven, resetsAt: SEC + 86400 * 3 },
  at: SEC,
  lines: lines || [],
});

test('прежний список запуска переезжает в карточки без потерь', () => {
  const list = subs.cards([{ cmd: 'claude', flags: '' }, { cmd: 'claude-my', flags: '--model sonnet' }]);
  assert.deepStrictEqual(list.map((c) => c.line), ['claude', 'claude-my --model sonnet']);
  assert.deepStrictEqual(list.map((c) => c.name), ['', '']);
  assert.deepStrictEqual(list.map((c) => c.bar), [true, true], 'остатки показываем без спроса');
});

test('пустая строка запуска карточкой не становится', () => {
  assert.strictEqual(subs.cards([{ line: '   ' }, { cmd: '' }, { line: 'claude' }]).length, 1);
});

test('ярлык — имя, а без имени строка запуска', () => {
  assert.strictEqual(subs.label({ line: 'claude-my --model sonnet', name: 'личная' }), 'личная');
  assert.strictEqual(subs.label({ line: 'claude-my --model sonnet' }), 'claude-my --model sonnet');
});

test('аккаунт без карточки назван папкой конфига', () => {
  assert.strictEqual(subs.aliasOfHome('/Users/x/.claude-my'), 'claude-my');
  assert.strictEqual(subs.aliasOfHome('/Users/x/.claude'), 'claude');
  assert.strictEqual(subs.aliasOfHome(''), 'claude');
});

test('карточка находится по запомненной папке, а не по имени команды', () => {
  const list = subs.cards([{ line: 'cld', home: '/h/.claude-work' }, { line: 'claude' }]);
  assert.strictEqual(subs.matchIndex(list, acc('/h/.claude-work', 10, 20)), 0);
});

test('в первый раз карточка находится по стему строки запуска', () => {
  const list = subs.cards([{ line: 'claude' }, { line: 'claude-my --model sonnet' }]);
  assert.strictEqual(subs.matchIndex(list, acc('/h/.claude-my', 5, 5, ['claude-my --model sonnet'])), 1);
  assert.strictEqual(subs.matchIndex(list, acc('/h/.claude', 5, 5, ['claude --session-id x'])), 0);
});

test('чужой аккаунт ни к одной карточке не привязывается', () => {
  const list = subs.cards([{ line: 'claude' }]);
  assert.strictEqual(subs.matchIndex(list, acc('/h/.claude-my', 5, 5, ['codex'])), -1);
});

test('папка конфига запоминается в карточке один раз', () => {
  const list = subs.cards([{ line: 'claude-my' }]);
  const learned = subs.learnHome(list, [acc('/h/.claude-my', 5, 5, ['claude-my'])]);
  assert.strictEqual(learned[0].home, '/h/.claude-my');
  assert.strictEqual(subs.learnHome(learned, [acc('/h/.claude-my', 5, 5, ['claude-my'])]), learned,
    'второй раз список не пересобирается — рендерер по этому решает, сохранять ли');
});

test('по умолчанию в панели ОБА окна', () => {
  // Человек смотрит в панель, чтобы знать свой запас целиком, а не худшую из двух цифр.
  const p = subs.pills({
    cards: [{ line: 'claude', name: 'рабочая' }],
    accounts: [acc('/h/.claude', 65, 83, ['claude'])],
    now: NOW,
  });
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].label, 'рабочая');
  assert.deepStrictEqual(p[0].items.map((i) => [i.lab, i.spent]), [['5ч', 65], ['7д', 83]]);
});

test('«то, что ближе к концу» оставляет одно число — по расходу, а не по длине окна', () => {
  const p = subs.pills({
    cards: [{ line: 'claude' }], accounts: [acc('/h/.claude', 65, 83, ['claude'])],
    view: { window: 'worst' }, now: NOW,
  });
  assert.deepStrictEqual(p[0].items.map((i) => [i.lab, i.spent]), [['7д', 83]]);
});

test('вид чинится к обоим окнам, а не к прежнему одному числу', () => {
  assert.deepStrictEqual(subs.view({}), { window: 'both', eta: 'tight', highlight: 'numbers' });
});

test('пороги те же, что у строки статуса и у ворот', () => {
  assert.strictEqual(subs.levelOf(74), '');
  assert.strictEqual(subs.levelOf(75), 'tight');
  assert.strictEqual(subs.levelOf(89), 'tight');
  assert.strictEqual(subs.levelOf(90), 'crit');
});

test('время сброса появляется только у поджавшего окна', () => {
  const eta = (five, seven, view) => subs.pills({
    cards: [{ line: 'claude' }], accounts: [acc('/h/.claude', five, seven, ['claude'])],
    view, now: NOW,
  })[0].items.map((i) => i.eta);
  assert.deepStrictEqual(eta(20, 30), ['', ''], 'спокойные окна отсчёта не просят');
  assert.deepStrictEqual(eta(20, 88), ['', '3д'], 'отсчёт только у того, что поджало');
  assert.deepStrictEqual(eta(20, 30, { eta: 'always' }), ['1ч', '3д']);
  assert.deepStrictEqual(eta(20, 95, { eta: 'never' }), ['', '']);
});

test('«только 5ч» оставляет одно окно, даже когда недельное хуже', () => {
  const five = subs.pills({
    cards: [{ line: 'claude' }], accounts: [acc('/h/.claude', 65, 83, ['claude'])],
    view: { window: 'five' }, now: NOW,
  });
  assert.deepStrictEqual(five[0].items.map((i) => i.spent), [65]);
});

test('нет чисел — нет пилюли (ноль вместо неизвестного — вранье)', () => {
  assert.deepStrictEqual(subs.pills({
    cards: [{ line: 'codex' }], accounts: [acc('/h/.claude', null, null, ['codex'])], now: NOW,
  }), []);
  assert.deepStrictEqual(subs.pills({ cards: [{ line: 'claude' }], accounts: [], now: NOW }), []);
});

test('снятая галка убирает пилюлю, но из списка подписку не убирает', () => {
  // Список только рассказывает; исчезни в нём подписка — снятая галка читалась бы как «её нет».
  const cards = [{ line: 'claude', name: 'рабочая', bar: false }];
  const accounts = [acc('/h/.claude', 65, 83, ['claude'])];
  assert.deepStrictEqual(subs.pills({ cards, accounts, now: NOW }), []);
  const rows = subs.menuRows({ cards, accounts, now: NOW });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].inBar, false, 'сказано, что в панели её нет');
  assert.strictEqual(rows[0].known, true);
});

test('аккаунт без карточки виден: это его расход', () => {
  const accounts = [acc('/h/.claude-my', 40, 50, ['claude-my'])];
  const p = subs.pills({ cards: [], accounts, now: NOW });
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].label, 'claude-my');
  assert.strictEqual(subs.menuRows({ cards: [], accounts, now: NOW })[0].inBar, true);
});

test('порядок пилюль — как в карточках, а не по расходу', () => {
  const p = subs.pills({
    cards: [{ line: 'claude', name: 'рабочая' }, { line: 'claude-my', name: 'личная' }],
    accounts: [acc('/h/.claude-my', 90, 91, ['claude-my']), acc('/h/.claude', 5, 6, ['claude'])],
    now: NOW,
  });
  assert.deepStrictEqual(p.map((x) => x.label), ['рабочая', 'личная']);
});

test('в списке есть и подписка без чисел, и аккаунт без карточки', () => {
  const rows = subs.menuRows({
    cards: [{ line: 'codex' }, { line: 'claude', name: 'рабочая' }],
    accounts: [acc('/h/.claude', 10, 20, ['claude']), acc('/h/.claude-my', 30, 40, ['claude-my'])],
    now: NOW,
  });
  assert.deepStrictEqual(rows.map((r) => r.label), ['codex', 'рабочая', 'claude-my']);
  assert.deepStrictEqual(rows.map((r) => r.known), [false, true, true]);
});

// Пятичасовое окно в списке — ВСЕГДА словами («через N часов/минут»): часы на стене для окна
// короче суток надо пересчитывать в уме. Недельное, когда до сброса ещё далеко (здесь — трое
// суток), остаётся точным временем: далёкий сброс планировать удобнее по часам на стене.
test('в списке пятичасовое окно — отсчётом словами, недельное далёкое — точным временем', () => {
  const rows = subs.menuRows({
    cards: [{ line: 'claude', name: 'рабочая' }],
    accounts: [acc('/h/.claude', 10, 20, ['claude'])],
    now: NOW,
  });
  assert.strictEqual(rows[0].when.five, 'через 1 час', 'пятичасовое — словами');
  assert.ok(/^(в|во) \S+, \d\d:\d\d$/.test(rows[0].when.seven), 'сброс через дни — днём недели: ' + rows[0].when.seven);
  assert.strictEqual(rows[0].five.eta, '', 'в списке отсчёта-цифрами (fmtEta) нет вовсе');
});

// Тот же гибкий выбор для недельного окна, если до сброса меньше суток: точное время сюда не
// добралось бы, поэтому и оно переходит на отсчёт словами, как пятичасовое.
test('недельное окно тоже отсчётом словами, если до сброса меньше суток', () => {
  const soon = (home) => ({
    home, five: null, seven: { spent: 40, resetsAt: SEC + 3 * 3600 + 900 }, at: SEC, lines: ['claude'],
  });
  const rows = subs.menuRows({
    cards: [{ line: 'claude', name: 'рабочая' }],
    accounts: [soon('/h/.claude')],
    now: NOW,
  });
  assert.strictEqual(rows[0].when.seven, 'через 3 часа 15 минут');
});

test('fmtRel склоняет часы и минуты по числу, и молчит про нулевую часть', () => {
  assert.strictEqual(subs.fmtRel(3600), 'через 1 час');
  assert.strictEqual(subs.fmtRel(2 * 3600), 'через 2 часа');
  assert.strictEqual(subs.fmtRel(5 * 3600), 'через 5 часов');
  assert.strictEqual(subs.fmtRel(15 * 60), 'через 15 минут');
  assert.strictEqual(subs.fmtRel(60), 'через 1 минуту');
  assert.strictEqual(subs.fmtRel(2 * 3600 + 15 * 60), 'через 2 часа 15 минут');
  assert.strictEqual(subs.fmtRel(0), 'через минуту', 'меньше минуты — не «через 0 минут»');
  assert.strictEqual(subs.fmtRel(11 * 3600), 'через 11 часов', '11 — тоже «часов», не «часа»');
});

test('«завтра» названо завтрашним днём, а не днём недели', () => {
  const noon = new Date(2026, 7, 26, 12, 0, 0).getTime();
  const nextMorning = new Date(2026, 7, 27, 9, 30, 0).getTime();
  assert.strictEqual(subs.fmtWhen(nextMorning, noon), 'завтра в 09:30');
  assert.strictEqual(subs.fmtWhen(new Date(2026, 7, 26, 19, 40, 0).getTime(), noon), 'в 19:40');
});

test('имя подписки для агента берётся по папке конфига, а не по строке', () => {
  const list = subs.cards([{ line: 'claude-my', name: 'личная', home: '/h/.claude-my' }, { line: 'claude' }]);
  assert.strictEqual(subs.nameForHome(list, '/h/.claude-my'), 'личная');
  assert.strictEqual(subs.nameForHome(list, '/h/.claude'), '', 'имени человек не дал — не придумываем');
  assert.strictEqual(subs.nameForHome(list, ''), '');
});

test('отсчёт до сброса говорит то же, что строка статуса', () => {
  for (const s of [0, 59, 60, 1080, 8040, 3600, 90_000, 86_400 * 3 + 3600 * 18]) {
    assert.strictEqual(subs.fmtEta(s), statusline.fmtEta(s), 'разошлись на ' + s + ' с');
  }
});

test('предпросмотр рисует пилюлю на условных цифрах, пока настоящих не видели', () => {
  const p = subs.previewPills({ cards: [{ line: 'claude', name: 'рабочая' }], accounts: [], now: NOW });
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].demo, true);
  assert.deepStrictEqual(p[0].items.map((i) => i.lab), ['5ч', '7д']);
  assert.ok(p[0].items.every((i) => typeof i.spent === 'number'), 'форма видна и без настоящих чисел');
});

test('предпросмотр берёт настоящие числа, если они уже пришли', () => {
  const p = subs.previewPills({
    cards: [{ line: 'claude', name: 'рабочая' }],
    accounts: [acc('/h/.claude', 65, 83, ['claude'])],
    now: NOW,
  });
  assert.strictEqual(p[0].demo, false);
  assert.deepStrictEqual(p[0].items.map((i) => i.spent), [65, 83]);
});

test('снятая галка убирает пилюлю из предпросмотра', () => {
  const p = subs.previewPills({ cards: [{ line: 'claude', bar: false }], accounts: [], now: NOW });
  assert.deepStrictEqual(p, []);
});

test('аккаунт без карточки в предпросмотре не выдумывается', () => {
  const p = subs.previewPills({ cards: [], accounts: [acc('/h/.claude-my', null, null, ['claude-my'])], now: NOW });
  assert.deepStrictEqual(p, [], 'карточку человек ещё не открыл — придумывать ей окна незачем');
});

test('вид чинится, если в настройках лежит чепуха', () => {
  assert.deepStrictEqual(subs.view({ window: 'nope', eta: 'nope', highlight: 'nope' }),
    { window: 'both', eta: 'tight', highlight: 'numbers' });
  assert.deepStrictEqual(subs.view(null), { window: 'both', eta: 'tight', highlight: 'numbers' });
  assert.deepStrictEqual(subs.view({ window: 'both', eta: 'never', highlight: 'fill' }),
    { window: 'both', eta: 'never', highlight: 'fill' });
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + (e.message || e)); process.exitCode = 1; }
}
console.log(`subs: ${passed}/${tests.length}`);
