// Plain-node tests for the CPU-badge arithmetic (no framework: run
// `node test/cpu.test.js`). cpu.js is dual-mode (browser global + CommonJS),
// so it can be required straight into Node.
const assert = require('assert');
const C = require('../cpu');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('cpuSecondsFromTime parses M:SS.ss', () => {
  assert.strictEqual(C.cpuSecondsFromTime('0:00.06'), 0.06);
  assert.strictEqual(C.cpuSecondsFromTime('1:30'), 90);
  assert.strictEqual(C.cpuSecondsFromTime('1090:23.88'), 1090 * 60 + 23.88);
});

test('cpuSecondsFromTime rejects garbage without throwing', () => {
  assert.strictEqual(C.cpuSecondsFromTime(''), null);
  assert.strictEqual(C.cpuSecondsFromTime(undefined), null);
  assert.strictEqual(C.cpuSecondsFromTime('not-a-time'), null);
  assert.strictEqual(C.cpuSecondsFromTime('20-22:09:10'), null); // etime, не time
});

test('cpuPctFromDelta: the whole machine busy the whole window is 100%', () => {
  const pct = C.cpuPctFromDelta(0, 40, 0, 5000, 8); // 8 ядер по 5s CPU за 5s стенных
  assert.ok(Math.abs(pct - 100) < 1e-9, pct);
});

test('cpuPctFromDelta: one busy core is a share of the machine, not 100%', () => {
  const pct = C.cpuPctFromDelta(0, 5, 0, 5000, 10); // +5s CPU за 5s стенных = 1 ядро из 10
  assert.ok(Math.abs(pct - 10) < 1e-9, pct);
});

test('cpuPctFromDelta: idle process over a window is 0%', () => {
  assert.strictEqual(C.cpuPctFromDelta(10, 10, 0, 5000, 8), 0);
});

test('cpuPctFromDelta: missing or nonsense core count is read as a single core', () => {
  // Так вёл себя расчёт до перевода на всю машину — на нём и остаёмся, если ядер не назвали:
  // это хотя бы честный процент одного ядра, а не деление на ноль и Infinity на карточке.
  assert.strictEqual(C.cpuPctFromDelta(0, 5, 0, 5000), 100);
  assert.strictEqual(C.cpuPctFromDelta(0, 5, 0, 5000, 0), 100);
  assert.strictEqual(C.cpuPctFromDelta(0, 5, 0, 5000, NaN), 100);
});

test('cpuPctFromDelta: shrinking tree (process exited) never goes negative', () => {
  const pct = C.cpuPctFromDelta(50, 10, 0, 5000, 8); // дерево сменилось, cs "упало"
  assert.strictEqual(pct, 0);
});

test('cpuPctFromDelta: zero or negative wall time is not a measurement', () => {
  assert.strictEqual(C.cpuPctFromDelta(0, 5, 1000, 1000, 8), null);
  assert.strictEqual(C.cpuPctFromDelta(0, 5, 2000, 1000, 8), null);
});

test('cpuTier: below HIDE_BELOW is hidden (null)', () => {
  assert.strictEqual(C.cpuTier(null), null);
  assert.strictEqual(C.cpuTier(C.HIDE_BELOW - 0.01), null);
});

test('cpuTier: two bands above the hide threshold, no quiet green one', () => {
  assert.strictEqual(C.cpuTier(C.HIDE_BELOW), 'mid');
  assert.strictEqual(C.cpuTier(C.HI_AT - 0.01), 'mid');
  assert.strictEqual(C.cpuTier(C.HI_AT), 'hi');
  assert.strictEqual(C.cpuTier(100), 'hi');
});

test('cpuTier: a merely alive tab does not light the badge', () => {
  // Смысл значка — «эта вкладка жёстко грузит машину». Одно ядро из восьми под разговором —
  // норма, а не новость, и значка на такой вкладке быть не должно.
  assert.strictEqual(C.cpuTier(C.cpuPctFromDelta(0, 5, 0, 5000, 8)), null);
});

test('formatCpuBadge: hidden pct carries no tier or text', () => {
  const b = C.formatCpuBadge(3);
  assert.deepStrictEqual(b, { hidden: true, tier: null, text: '' });
});

test('formatCpuBadge: visible pct rounds and matches its tier', () => {
  const b = C.formatCpuBadge(73.4);
  assert.strictEqual(b.hidden, false);
  assert.strictEqual(b.tier, 'hi');
  assert.strictEqual(b.text, '73%');
});

test('formatCpuBadge: never shows more than 100% of the machine', () => {
  // Округление и дрожание тиков могут дать 100.4 — «101%» на карточке читалось бы как ошибка.
  assert.strictEqual(C.formatCpuBadge(100.4).text, '100%');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
