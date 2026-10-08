// Регион: разбор ответов сервисов и переходы «закрыт / открыт».
// Run: node test/geo.test.js
const assert = require('assert');
const GEO = require('../geo');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('cloudflare: страна из loc=', () => {
  const trace = 'fl=12f\nh=www.cloudflare.com\nip=1.2.3.4\nts=1.2\nloc=RU\ntls=TLSv1.3\n';
  assert.strictEqual(GEO.parseTrace(trace), 'RU');
  assert.strictEqual(GEO.parseTrace('loc=th\n'), 'TH');
});

test('cloudflare: нет loc или мусор — пусто, а не догадка', () => {
  assert.strictEqual(GEO.parseTrace('<html>error</html>'), '');
  assert.strictEqual(GEO.parseTrace(''), '');
  assert.strictEqual(GEO.parseTrace(null), '');
  assert.strictEqual(GEO.parseTrace('colo=loc=RU'), '');
});

test('ipinfo: двухбуквенный код, остальное — пусто', () => {
  assert.strictEqual(GEO.parsePlain('RU\n'), 'RU');
  assert.strictEqual(GEO.parsePlain('de'), 'DE');
  assert.strictEqual(GEO.parsePlain('{"error":"rate limit"}'), '');
  assert.strictEqual(GEO.parsePlain(''), '');
});

test('РФ закрывает, другая страна открывает', () => {
  assert.strictEqual(GEO.nextBlocked(false, 'RU'), true);
  assert.strictEqual(GEO.nextBlocked(true, 'TH'), false);
  assert.strictEqual(GEO.nextBlocked(false, 'ru'), true);
});

test('ответа нет — состояние не меняется ни в одну сторону', () => {
  assert.strictEqual(GEO.nextBlocked(false, ''), false);
  assert.strictEqual(GEO.nextBlocked(true, ''), true);
  assert.strictEqual(GEO.nextBlocked(undefined, ''), false);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log('ok —', name); } catch (e) { console.error('FAIL —', name); console.error(e); process.exit(1); }
}
console.log(`\n${passed}/${tests.length} geo tests passed`);
