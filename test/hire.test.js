// Найм по просьбе прораба: имя файла заявки, потолок бригады, разбор содержимого.
// Run: node test/hire.test.js
const assert = require('assert');
const HIRE = require('../hire');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// --- fileName -----------------------------------------------------------------------
test('имя файла — по id разговора, как у digest/restart', () => {
  assert.strictEqual(HIRE.fileName('c0ffee'), '.swarm-hire-c0ffee.json');
});

test('нет id — нет имени: писать было бы некуда', () => {
  assert.strictEqual(HIRE.fileName(''), '');
  assert.strictEqual(HIRE.fileName(null), '');
});

test('id санитайзится так же, как у digest.fileName', () => {
  assert.strictEqual(HIRE.fileName('a/b c'), '.swarm-hire-a_b_c.json');
});

// --- clampCeiling ---------------------------------------------------------------------
test('потолок: не задано — умолчание, а не ноль', () => {
  assert.strictEqual(HIRE.clampCeiling(null), HIRE.DEFAULT_MAX);
  assert.strictEqual(HIRE.clampCeiling(''), HIRE.DEFAULT_MAX);
  assert.strictEqual(HIRE.clampCeiling(undefined), HIRE.DEFAULT_MAX);
});

test('потолок: зажимается в границы', () => {
  assert.strictEqual(HIRE.clampCeiling(0), HIRE.MIN_MAX);
  assert.strictEqual(HIRE.clampCeiling(-5), HIRE.MIN_MAX);
  assert.strictEqual(HIRE.clampCeiling(999), HIRE.MAX_MAX);
});

test('потолок: не число — умолчание', () => {
  assert.strictEqual(HIRE.clampCeiling('вагон'), HIRE.DEFAULT_MAX);
});

test('потолок: обычное значение проходит как есть', () => {
  assert.strictEqual(HIRE.clampCeiling(3), 3);
  assert.strictEqual(HIRE.clampCeiling('10'), 10);
});

// --- parseRequest ---------------------------------------------------------------------
test('заявка разбирается: имя, задача, модель', () => {
  const out = HIRE.parseRequest(JSON.stringify({
    hire: [{ name: '#629', prompt: 'почини форму оплаты', model: 'Sonnet' }],
  }));
  assert.deepStrictEqual(out, [{ name: '#629', prompt: 'почини форму оплаты', model: 'sonnet' }]);
});

test('несколько заявок разом', () => {
  const out = HIRE.parseRequest(JSON.stringify({
    hire: [{ name: '#1', prompt: 'a' }, { name: '#2', prompt: 'b' }],
  }));
  assert.strictEqual(out.length, 2);
});

test('model необязателен', () => {
  const out = HIRE.parseRequest(JSON.stringify({ hire: [{ name: '#1', prompt: 'a' }] }));
  assert.strictEqual(out[0].model, '');
});

test('без имени или без задачи — запись пропускается, не всё падает', () => {
  const out = HIRE.parseRequest(JSON.stringify({
    hire: [{ name: '#1' }, { prompt: 'без имени' }, { name: '#2', prompt: 'годная' }],
  }));
  assert.deepStrictEqual(out.map((e) => e.name), ['#2']);
});

test('не JSON или не объект — пустой массив, не исключение', () => {
  assert.deepStrictEqual(HIRE.parseRequest('не json вовсе'), []);
  assert.deepStrictEqual(HIRE.parseRequest('null'), []);
  assert.deepStrictEqual(HIRE.parseRequest('{}'), []);
  assert.deepStrictEqual(HIRE.parseRequest('{"hire": "не массив"}'), []);
});

test('имя и задача обрезаются по потолку длины, а не отвергаются', () => {
  const longName = 'x'.repeat(200);
  const longPrompt = 'y'.repeat(10000);
  const out = HIRE.parseRequest(JSON.stringify({ hire: [{ name: longName, prompt: longPrompt }] }));
  assert.strictEqual(out[0].name.length, HIRE.NAME_MAX);
  assert.strictEqual(out[0].prompt.length, HIRE.PROMPT_MAX);
});

test('заявок в одном файле больше потолка — берём только первые', () => {
  const hire = [];
  for (let i = 0; i < HIRE.MAX_PER_FILE + 5; i++) hire.push({ name: '#' + i, prompt: 'делай' });
  const out = HIRE.parseRequest(JSON.stringify({ hire }));
  assert.strictEqual(out.length, HIRE.MAX_PER_FILE);
});

// --- prorabIntro ----------------------------------------------------------------------
test('строка новому прорабу: путь заявки, формат, потолок, и «ничего не нанимай сам»', () => {
  const t = HIRE.prorabIntro('/p/.swarm-hire-c0ffee.json', 4);
  assert.match(t, /\/p\/\.swarm-hire-c0ffee\.json/);
  assert.match(t, /\{"hire": \[\{"name"/);
  assert.match(t, /Потолок бригады: 4/);
  assert.match(t, /разрешения.*человеку/);
  assert.match(t, /ничего не нанимай/);
});

test('строка новому прорабу: потолок зажимается, как настройка', () => {
  assert.match(HIRE.prorabIntro('/f', null), new RegExp(`Потолок бригады: ${HIRE.DEFAULT_MAX}`));
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ok — ' + name); }
    catch (e) { console.error('FAIL — ' + name + '\n  ' + e.message); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
