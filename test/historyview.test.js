// Окно прошлых разговоров (renderer/historyview.js): строки, поиск, подпись даты.
const assert = require('assert');
const V = require('../renderer/historyview');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
const at = (y, m, d, h = 12) => new Date(y, m, d, h).getTime();

test('строка: у записи имя и саммари главнее, без записи — первая просьба', () => {
  const f = { id: 'a', at: 1, cwd: '/p/shop', prompt: 'поправь даты', title: '' };
  const withRec = V.row(f, { name: 'Даты в отчёте', summary: 'Правили формат дат', digest: 'делаю' });
  assert.strictEqual(withRec.name, 'Даты в отчёте');
  assert.strictEqual(withRec.about, 'Правили формат дат');
  assert.strictEqual(withRec.noname, false);
  const noRec = V.row(f, null);
  assert.strictEqual(noRec.name, 'поправь даты');
  assert.strictEqual(noRec.about, '');
  assert.strictEqual(noRec.noname, true);
});

test('строка: нет саммари — дайджест, нет и его — первая просьба', () => {
  const f = { id: 'a', at: 1, prompt: 'исходная просьба', title: '' };
  assert.strictEqual(V.row(f, { name: 'Имя', digest: 'сейчас делаю' }).about, 'сейчас делаю');
  assert.strictEqual(V.row(f, { name: 'Имя' }).about, 'исходная просьба');
});

test('строка: папка берётся с диска, а без неё из записи', () => {
  assert.strictEqual(V.row({ id: 'a', at: 1, prompt: 'x', cwd: '/d' }, { cwd: '/r' }).cwd, '/d');
  assert.strictEqual(V.row({ id: 'a', at: 1, prompt: 'x' }, { cwd: '/r' }).cwd, '/r');
});

test('поиск: все слова, любой регистр, по саммари и по первой просьбе', () => {
  const rows = [
    V.row({ id: '1', at: 3, prompt: 'добавь экспорт в CSV' }, { name: 'Экспорт', summary: 'Выгрузка заказов для бухгалтерии' }),
    V.row({ id: '2', at: 2, prompt: 'почему падает CI' }, null),
    V.row({ id: '3', at: 1, prompt: 'тёмная тема' }, { name: 'Тема', summary: 'Переключатель тёмной темы' }),
  ];
  assert.deepStrictEqual(V.filter(rows, 'БУХГАЛТЕРИЯ').map((r) => r.id), []);
  assert.deepStrictEqual(V.filter(rows, 'бухгалтер').map((r) => r.id), ['1']);
  assert.deepStrictEqual(V.filter(rows, 'csv заказов').map((r) => r.id), ['1']);
  assert.deepStrictEqual(V.filter(rows, 'ci').map((r) => r.id), ['2']);
  assert.deepStrictEqual(V.filter(rows, '  ').map((r) => r.id), ['1', '2', '3']);
  assert.deepStrictEqual(V.filter(rows, 'csv падает').map((r) => r.id), []);
});

test('дата: день, месяц и время; чужой год — с годом', () => {
  const now = at(2026, 10, 12);
  assert.strictEqual(V.when(at(2026, 10, 12, 18) + 43 * 60000, now), '12 ноя., 18:43');
  assert.strictEqual(V.when(at(2026, 9, 1, 9), now), '1 окт., 09:00');
  assert.strictEqual(V.when(at(2025, 11, 31, 22) + 10 * 60000, now), '31 дек. 2025, 22:10');
});

for (const [name, fn] of tests) {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name, '\n', e.message); process.exit(1); }
}
console.log(`historyview: ${passed}/${tests.length} ok`);
