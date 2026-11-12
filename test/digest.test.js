// Файл дайджеста: текст, имя вкладки и саммари для истории (digest.js).
const assert = require('assert');
const D = require('../digest');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
const raw = (o) => JSON.stringify(o);

test('саммари читается из третьего поля, пробелы схлопываются', () => {
  assert.strictEqual(D.readSummary(raw({ digest: 'x', summary: '  Переезд оплаты\nна новый шлюз  ' })), 'Переезд оплаты на новый шлюз');
});

test('саммари: нет поля, не объект, битый JSON — пусто', () => {
  assert.strictEqual(D.readSummary(raw({ digest: 'x' })), '');
  assert.strictEqual(D.readSummary('мусор'), '');
  assert.strictEqual(D.readSummary('null'), '');
  assert.strictEqual(D.readSummary(raw({ summary: 5 })), '5');
});

test('саммари режется по жёсткому потолку с многоточием', () => {
  const long = 'а'.repeat(D.SUMMARY_MAX + 50);
  const got = D.readSummary(raw({ summary: long }));
  assert.strictEqual(got.length, D.SUMMARY_MAX);
  assert.ok(got.endsWith('…'));
});

test('саммари не мешает дайджесту и имени', () => {
  const r = raw({ title: 'Экспорт', digest: 'делаю выгрузку', summary: 'вся задача' });
  assert.strictEqual(D.readText(r), 'делаю выгрузку');
  assert.strictEqual(D.readTitle(r), 'Экспорт');
});

for (const [name, fn] of tests) {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name, '\n', e.message); process.exit(1); }
}
console.log(`digest: ${passed}/${tests.length} ok`);
