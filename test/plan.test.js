// Разбор раздела «## План» (plan.js): дерево, счёт верхних шагов, «где мы».
const assert = require('assert');
const P = require('../plan');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
const doc = (body) => `# Работа\n\n## Вход\nx\n\n## План\n${body}\n\n## Где стою\nтут\n`;

test('нет раздела — плана нет', () => {
  assert.strictEqual(P.parse('# Работа\n\n## Вход\n[ ] a\n[ ] b\n'), null);
  assert.strictEqual(P.parse(''), null);
  assert.strictEqual(P.parse(null), null);
});

test('одна строка — ещё не план', () => {
  assert.strictEqual(P.parse(doc('- [ ] один')), null);
});

test('подсказка-комментарий и пояснения не считаются', () => {
  const t = doc('<!-- [x] сделано, [ ] нет -->\nпросто текст');
  assert.strictEqual(P.parse(t), null);
});

test('счёт верхних шагов и «где мы» по [>]', () => {
  const p = P.parse(doc('- [x] a\n- [>] b\n- [ ] c\n- [ ] d'));
  assert.strictEqual(p.total, 4);
  assert.strictEqual(p.done, 1);
  assert.strictEqual(p.nowIndex, 1);
  assert.deepStrictEqual(p.tree.map((n) => n.state), ['done', 'now', 'todo', 'todo']);
});

test('без [>] — первый незакрытый; всё сделано — -1', () => {
  assert.strictEqual(P.parse(doc('[x] a\n[x] b\n[ ] c')).nowIndex, 2);
  const all = P.parse(doc('[x] a\n[X] b'));
  assert.strictEqual(all.nowIndex, -1);
  assert.strictEqual(all.done, 2);
});

test('вложенность до трёх уровней; [>] в подшаге относит «где мы» к верхнему', () => {
  const p = P.parse(doc('- [x] a\n- [ ] b\n  - [x] b1\n  - [ ] b2\n    - [>] b2a\n- [ ] c'));
  assert.strictEqual(p.total, 3);
  assert.strictEqual(p.nowIndex, 1);
  assert.strictEqual(p.tree[1].children.length, 2);
  assert.strictEqual(p.tree[1].children[1].children[0].state, 'now');
  assert.strictEqual(p.tree[1].children[1].children[0].text, 'b2a');
});

test('CRLF, заглавная [X], табы и пункты без дефиса', () => {
  const p = P.parse(doc('[X] a\r\n[ ] b\r\n\t[ ] b1\r\n').replace(/\n/g, '\r\n'));
  assert.strictEqual(p.total, 2);
  assert.strictEqual(p.tree[0].state, 'done');
  assert.strictEqual(p.tree[1].children.length, 1);
});

test('кривые отступы не роняют: шаг глубже без родителя становится верхним', () => {
  const p = P.parse(doc('    - [ ] a\n  - [ ] b\n- [ ] c'));
  assert.ok(p);
  assert.ok(p.total >= 1);
});

test('раздел кончается на следующем заголовке ##; ### внутри остаётся', () => {
  const t = '## План\n[ ] a\n### Подраздел\n[ ] b\n## Дальше\n[ ] не мой\n[ ] тоже';
  const p = P.parse(t);
  assert.strictEqual(P.parseTree(t).length, 2);
  assert.strictEqual(p.total, 2);
});

test('пустая подпись отметки пропускается', () => {
  assert.strictEqual(P.parse(doc('[ ]\n[ ] a')), null);
});

test('нумерованные пункты «1. [ ]» и «1) [x]» читаются', () => {
  const p = P.parse(doc('1. [x] a\n2. [>] b\n3) [ ] c'));
  assert.strictEqual(p.total, 3);
  assert.strictEqual(p.nowIndex, 1);
});

test('«## …» внутри комментария не обрывает раздел', () => {
  const p = P.parse(doc('<!-- пример:\n## Не заголовок\n-->\n[ ] a\n[ ] b'));
  assert.strictEqual(p.total, 2);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name, '\n', e.message); process.exit(1); }
}
console.log(`plan: ${passed}/${tests.length} ok`);
