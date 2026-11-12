// Подписи свёрнутой левой панели (renderer/railmini.js): инициалы карточки и сокращение папки.
const assert = require('assert');
const R = require('../renderer/railmini');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('инициалы: два слова — первые буквы, заглавные', () => {
  assert.strictEqual(R.tabInitials('Окно оплаты'), 'ОО');
  assert.strictEqual(R.tabInitials('Письма о заказе'), 'ПО');
  assert.strictEqual(R.tabInitials('api gateway'), 'AG');
});

test('инициалы: одно слово — две первые буквы', () => {
  assert.strictEqual(R.tabInitials('claude'), 'CL');
  assert.strictEqual(R.tabInitials('x'), 'X');
});

test('инициалы: дефис, подчёркивание и цифры', () => {
  assert.strictEqual(R.tabInitials('fix-login_bug'), 'FL');
  assert.strictEqual(R.tabInitials('shop 2'), 'S2');
});

test('инициалы: пусто и знаки — точка, а не пустота', () => {
  assert.strictEqual(R.tabInitials(''), '·');
  assert.strictEqual(R.tabInitials(null), '·');
  assert.strictEqual(R.tabInitials('— !!'), '·');
});

test('инициалы: эмодзи в начале не съедают букву', () => {
  assert.strictEqual(R.tabInitials('🚀 Релиз сайта'), 'РС');
});

test('папка: части имени → до трёх букв', () => {
  assert.strictEqual(R.folderAbbr('payments-gateway-v2'), 'PGV');
  assert.strictEqual(R.folderAbbr('marketing-site'), 'MS');
  assert.strictEqual(R.folderAbbr('a-b-c-d'), 'ABC');
});

test('папка: одно слово — первые три буквы', () => {
  assert.strictEqual(R.folderAbbr('shop'), 'SHO');
  assert.strictEqual(R.folderAbbr('go'), 'GO');
});

test('папка: пусто — точка', () => {
  assert.strictEqual(R.folderAbbr(''), '·');
});

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log('  ok  ' + name); } catch (e) {
    console.error('FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1;
  }
}
console.log(`\n${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
