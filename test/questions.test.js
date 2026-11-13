// Вопросы вкладки (questions.js): разбор файла агента, вопросы с вариантами из журнала, лента.
const assert = require('assert');
const Q = require('../questions');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('пустой шаблон — вопросов нет', () => {
  assert.deepStrictEqual(Q.parseFile(Q.template()), []);
  assert.deepStrictEqual(Q.parseFile(''), []);
  assert.deepStrictEqual(Q.parseFile(null), []);
});

test('вопрос без ответа и с ответом', () => {
  const t = Q.template() + '- Апи старое выключаем?\n  → Через неделю\n- СБП сразу или через сутки?\n';
  assert.deepStrictEqual(Q.parseFile(t), [
    { q: 'Апи старое выключаем?', a: 'Через неделю' },
    { q: 'СБП сразу или через сутки?', a: null },
  ]);
});

test('продолжение строк: вопрос до стрелки, ответ после', () => {
  const t = '- Длинный вопрос,\n  который продолжается\n  -> да,\n  но с оговоркой\n';
  assert.deepStrictEqual(Q.parseFile(t), [{ q: 'Длинный вопрос, который продолжается', a: 'да, но с оговоркой' }]);
});

test('«Ответ:» тоже ответ; пустая стрелка — ответ без слов', () => {
  assert.deepStrictEqual(Q.parseFile('* a?\n  Ответ: нет\n- b?\n  →\n'), [{ q: 'a?', a: 'нет' }, { q: 'b?', a: '—' }]);
});

test('пункт с отступом — не новый вопрос, а продолжение', () => {
  assert.deepStrictEqual(Q.parseFile('- a?\n  - деталь\n'), [{ q: 'a? - деталь', a: null }]);
});

const ask = (id, at, qs) => ({ type: 'assistant', timestamp: new Date(at).toISOString(),
  message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: qs.map((q) => ({ question: q })) } }] } });
const res = (id, at, answers, isError) => ({ type: 'user', timestamp: new Date(at).toISOString(),
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !!isError, content: 'x' }] },
  toolUseResult: answers ? { questions: [], answers } : 'User rejected' });
const say = (at) => ({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { content: [{ type: 'text', text: 'ok' }] } });

test('коробка с ответом раскладывается по вопросам', () => {
  const ev = Q.boxEvents([ask('t1', 1000, ['A?', 'B?']), res('t1', 2000, { 'A?': 'да', 'B?': ['x', 'y'] }), say(3000)]);
  const r = Q.absorbBox([], ev);
  assert.deepStrictEqual(r.box.map((x) => [x.q, x.a, x.at, x.aAt]), [['A?', 'да', 1000, 2000], ['B?', 'x, y', 1000, 2000]]);
  assert.deepStrictEqual(r.open, []);
  assert.deepStrictEqual(r.pending, []);
});

test('коробка на экране — ждёт; ответ приходит в следующем куске журнала', () => {
  const r1 = Q.absorbBox([], Q.boxEvents([say(500), ask('t1', 1000, ['A?'])]));
  assert.deepStrictEqual(r1.open.map((x) => x.q), ['A?']);
  const r2 = Q.absorbBox(r1.box, Q.boxEvents([res('t1', 2000, { 'A?': 'да' })], r1.pending));
  assert.deepStrictEqual(r2.open, []);
  assert.deepStrictEqual(r2.box.map((x) => x.a), ['да']);
});

test('отказ или закрытая коробка не оставляют ничего', () => {
  const r = Q.absorbBox([], Q.boxEvents([ask('t1', 1000, ['A?']), res('t1', 2000, null, true)]));
  assert.deepStrictEqual(r.box, []);
  assert.deepStrictEqual(r.open, []);
});

test('коробка без ответа, после которой журнал пошёл дальше, — не ждёт', () => {
  const r = Q.absorbBox([], Q.boxEvents([ask('t1', 1000, ['A?']), say(5000)]));
  assert.deepStrictEqual(r.open, []);
  assert.deepStrictEqual(r.pending, []);
});

test('повторное чтение не дублирует пары', () => {
  const ev = () => Q.boxEvents([ask('t1', 1000, ['A?']), res('t1', 2000, { 'A?': 'да' })]);
  const r1 = Q.absorbBox([], ev());
  const r2 = Q.absorbBox(r1.box, ev());
  assert.strictEqual(r2.box.length, 1);
});

test('подагент не в счёт', () => {
  const e = ask('t1', 1000, ['A?']);
  e.isSidechain = true;
  assert.deepStrictEqual(Q.boxEvents([e]).asks, []);
});

test('штампы: первое чтение раскладывает по времени файла, дальше — момент появления', () => {
  const first = Q.stamp([{ q: 'a', a: 'x' }, { q: 'b', a: null }], {}, 100000, 50000);
  assert.deepStrictEqual(first.items.map((x) => x.at), [48000, 49000]);
  assert.strictEqual(first.items[0].aAt, 48000);
  assert.strictEqual(first.items[1].aAt, 0);
  const second = Q.stamp([{ q: 'a', a: 'x' }, { q: 'b', a: 'y' }, { q: 'c', a: null }], first.seen, 200000, 190000);
  assert.deepStrictEqual(second.items.map((x) => [x.at, x.aAt]), [[48000, 48000], [49000, 200000], [200000, 0]]);
});

test('лента: новые сверху, ждущие на своём месте, счёт ждущих', () => {
  const m = Q.merge(
    [{ q: 'old', a: 'x', at: 1, aAt: 2 }, { q: 'wait', a: null, at: 5, aAt: 0 }],
    [{ q: 'box', a: 'y', at: 7, aAt: 8 }],
    [{ q: 'open', a: null, at: 9 }]);
  assert.deepStrictEqual(m.items.map((x) => x.q), ['open', 'box', 'wait', 'old']);
  assert.strictEqual(m.waiting, 2);
  assert.strictEqual(m.total, 4);
  assert.strictEqual(Q.merge([], [], []), null);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
}
console.log(`questions: ${passed}/${tests.length} ok`);
