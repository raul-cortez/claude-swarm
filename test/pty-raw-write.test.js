// Пиннит замену node-pty's p.write() на голый fs.writeSync с ручной частичной записью:
// BUG-pty-deadlock-2026-08-11.md, docs/superpowers/specs/2026-08-27-pty-raw-write-design.md.
// node-pty внутри uv_write2 доедает недописанный остаток тугим ретраем, не отдавая такт
// циклу событий, — этот модуль делает то же самое руками, отдавая такт через schedule()
// между кусками. Фейковый writeSync, без реального pty.
// Run: node test/pty-raw-write.test.js
const assert = require('assert');
const RW = require('../pty-raw-write');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// Расписание в руках теста, как в pty-write.test.js: такт наступает только когда мы это
// разрешим, так видно, что ушло синхронно за один writeSync, а что ждало такта.
function harness(steps) {
  const calls = [];
  const scheduled = [];
  let i = 0;
  const writeSyncFn = (fd, buf, offset, length) => {
    calls.push({ fd, offset, length });
    const step = steps[i++];
    if (step && step.throw) throw step.throw;
    const n = step ? step.n : length;
    return n;
  };
  return {
    calls,
    writeSyncFn,
    schedule: (fn) => scheduled.push(fn),
    flush(limit = 1000) {
      let n = 0;
      while (scheduled.length && n++ < limit) scheduled.shift()();
    },
  };
}

test('всё ушло одним writeSync — ok:true, без единого такта', async () => {
  const h = harness([{ n: 5 }]);
  const buf = Buffer.from('abcde');
  const r = await RW.writeAll(h.writeSyncFn, 7, buf, h.schedule);
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(h.calls.length, 1);
  assert.strictEqual(h.calls[0].fd, 7);
  assert.strictEqual(h.calls[0].offset, 0);
  assert.strictEqual(h.calls[0].length, 5);
});

test('частичная запись — остаток уходит на следующий такт, не тем же вызовом', async () => {
  const h = harness([{ n: 2 }, { n: 2 }, { n: 1 }]);
  const buf = Buffer.from('abcde');
  const p = RW.writeAll(h.writeSyncFn, 7, buf, h.schedule);
  // Между тактами — ничего не дописалось сверх первого writeSync.
  assert.strictEqual(h.calls.length, 1);
  h.flush();
  const r = await p;
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(h.calls.length, 3);
  assert.deepStrictEqual(h.calls.map((c) => [c.offset, c.length]), [[0, 5], [2, 3], [4, 1]]);
});

test('EAGAIN — не ошибка, просто повторить на следующем такте', async () => {
  const eagain = new Error('EAGAIN'); eagain.code = 'EAGAIN';
  const h = harness([{ throw: eagain }, { n: 3 }]);
  const p = RW.writeAll(h.writeSyncFn, 7, Buffer.from('abc'), h.schedule);
  h.flush();
  const r = await p;
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(h.calls.length, 2);
});

test('EWOULDBLOCK — тоже просто повторить', async () => {
  const ewb = new Error('EWOULDBLOCK'); ewb.code = 'EWOULDBLOCK';
  const h = harness([{ throw: ewb }, { n: 3 }]);
  const p = RW.writeAll(h.writeSyncFn, 7, Buffer.from('abc'), h.schedule);
  h.flush();
  const r = await p;
  assert.deepStrictEqual(r, { ok: true });
});

test('EIO на закрытой вкладке — ok:false, остаток бросаем, дальше не пишем', async () => {
  const eio = new Error('EIO'); eio.code = 'EIO';
  const h = harness([{ n: 2 }, { throw: eio }]);
  const p = RW.writeAll(h.writeSyncFn, 7, Buffer.from('abcde'), h.schedule);
  h.flush();
  const r = await p;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.err, eio);
  assert.strictEqual(h.calls.length, 2, 'после ошибки повторных попыток быть не должно');
});

test('пустой буфер — ok:true, writeSync ни разу не вызван', async () => {
  const h = harness([]);
  const r = await RW.writeAll(h.writeSyncFn, 7, Buffer.alloc(0), h.schedule);
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(h.calls.length, 0);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; }
    catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
  }
  console.log(passed + '/' + tests.length + ' pty-raw-write tests passed');
})();
