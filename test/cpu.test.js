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

test('cpuPctFromDelta: one full core busy the whole window is 100%', () => {
  const pct = C.cpuPctFromDelta(0, 5, 0, 5000); // +5s CPU за 5s стенных
  assert.ok(Math.abs(pct - 100) < 1e-9, pct);
});

test('cpuPctFromDelta: idle process over a window is 0%', () => {
  assert.strictEqual(C.cpuPctFromDelta(10, 10, 0, 5000), 0);
});

test('cpuPctFromDelta: multi-core tree can exceed 100%', () => {
  const pct = C.cpuPctFromDelta(0, 10, 0, 5000); // +10s CPU за 5s стенных = 2 ядра
  assert.ok(Math.abs(pct - 200) < 1e-9, pct);
});

test('cpuPctFromDelta: shrinking tree (process exited) never goes negative', () => {
  const pct = C.cpuPctFromDelta(50, 10, 0, 5000); // дерево сменилось, cs "упало"
  assert.strictEqual(pct, 0);
});

test('cpuPctFromDelta: zero or negative wall time is not a measurement', () => {
  assert.strictEqual(C.cpuPctFromDelta(0, 5, 1000, 1000), null);
  assert.strictEqual(C.cpuPctFromDelta(0, 5, 2000, 1000), null);
});

test('cpuTier: below HIDE_BELOW is hidden (null)', () => {
  assert.strictEqual(C.cpuTier(null), null);
  assert.strictEqual(C.cpuTier(C.HIDE_BELOW - 0.01), null);
});

test('cpuTier: three bands above the hide threshold', () => {
  assert.strictEqual(C.cpuTier(C.HIDE_BELOW), 'lo');
  assert.strictEqual(C.cpuTier(C.MID_AT - 0.01), 'lo');
  assert.strictEqual(C.cpuTier(C.MID_AT), 'mid');
  assert.strictEqual(C.cpuTier(C.HI_AT - 0.01), 'mid');
  assert.strictEqual(C.cpuTier(C.HI_AT), 'hi');
  assert.strictEqual(C.cpuTier(999), 'hi');
});

test('formatCpuBadge: hidden pct carries no tier or text', () => {
  const b = C.formatCpuBadge(3);
  assert.deepStrictEqual(b, { hidden: true, tier: null, text: '' });
});

test('formatCpuBadge: visible pct rounds and matches its tier', () => {
  const b = C.formatCpuBadge(173.4);
  assert.strictEqual(b.hidden, false);
  assert.strictEqual(b.tier, 'hi');
  assert.strictEqual(b.text, '173%');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
