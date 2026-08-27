# PTY raw write Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `p.write(chunk)` inside `ptyOut`'s writer (main.js) with a manual, partial-write-aware `fs.writeSync` loop on POSIX, so a stalled pty reader can no longer freeze the Electron main thread the way `uv_write2`'s internal retry does inside node-pty.

**Architecture:** New leaf module `pty-raw-write.js` exports one pure function, `writeAll(writeSyncFn, fd, buffer, schedule)`, that writes a buffer to an fd in a loop: each call takes however many bytes the kernel accepted, and schedules the remainder for the next event-loop tick instead of retrying inline. `pty-write.js`'s `pump()`/`send()` become promise-aware so a queued multi-chunk send waits for one chunk's delivery to fully finish before dispatching the next — without changing behavior for today's synchronous `write` callbacks. `main.js` wires POSIX pty file descriptors through `writeAll`, keeping the existing `p.write(chunk)` path unchanged for Windows or when no fd is available, plus a 3s diagnostic timer that logs (not blocks) a stuck delivery.

**Tech Stack:** Node.js `fs.writeSync`, `setImmediate`, Promises. No new dependencies.

---

## File Structure

- **Create** `pty-raw-write.js` — pure `writeAll()`, no I/O of its own beyond the injected `writeSyncFn`/`schedule`.
- **Create** `test/pty-raw-write.test.js` — fake `writeSync` (partial writes, EAGAIN/EWOULDBLOCK, EIO), fake `schedule`, no real pty.
- **Modify** `pty-write.js` — `pump()`/`send()` await a promise from `write()` when one comes back, without disturbing the synchronous fast path.
- **Modify** `test/pty-write.test.js` — add one test for promise-returning `write`; make the runner `await` each test so an async test can run; existing sync tests untouched.
- **Modify** `main.js` (~line 120, the `ptyOut = ptyWrite.makeWriter({...})` call) — POSIX + numeric `p.fd` routes through `pty-raw-write.js`; everything else keeps `p.write(chunk)`. Adds a 3s `restartLog` diagnostic on a stuck delivery.
- **Modify** `package.json` — add `pty-raw-write.js` to `build.files` and `test/pty-raw-write.test.js` to `scripts.test`.

---

### Task 1: `pty-raw-write.js` — the raw partial-write loop

**Files:**
- Create: `pty-raw-write.js`
- Test: `test/pty-raw-write.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/pty-raw-write.test.js
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
```

- [ ] **Step 2: Run the tests, confirm they fail with "Cannot find module '../pty-raw-write'"**

Run: `node test/pty-raw-write.test.js`
Expected: throws `Error: Cannot find module '../pty-raw-write'`

- [ ] **Step 3: Write `pty-raw-write.js`**

```js
'use strict';
// pty-raw-write.js — доставка одного куска байт в fd мимо node-pty.
// Разбор: BUG-pty-deadlock-2026-08-11.md, docs/superpowers/specs/2026-08-27-pty-raw-write-design.md.
//
// node-pty пишет через net.Socket/uv_write2, и при частичной записи (обычное дело для pty,
// когда читатель на другом конце не поспевает) libuv сам, на C++-уровне, доедает остаток
// тугим ретраем — не отдавая такт циклу событий. 11 и 27 августа это вешало главный поток
// намертво со 100% CPU. Здесь то же самое, но руками: каждый вызов writeSyncFn берёт
// сколько ядро приняло за раз, а недописанный хвост уходит на следующий такт через
// schedule() — а не доедается тем же вызовом.

function writeAll(writeSyncFn, fd, buffer, schedule) {
  return new Promise((resolve) => {
    const total = buffer.length;
    let offset = 0;
    function step() {
      if (offset >= total) { resolve({ ok: true }); return; }
      let n;
      try {
        n = writeSyncFn(fd, buffer, offset, total - offset);
      } catch (err) {
        if (err && (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK')) { schedule(step); return; }
        resolve({ ok: false, err });
        return;
      }
      offset += n;
      if (offset >= total) { resolve({ ok: true }); return; }
      schedule(step);
    }
    step();
  });
}

module.exports = { writeAll };
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `node test/pty-raw-write.test.js`
Expected: `6/6 pty-raw-write tests passed`

- [ ] **Step 5: Commit**

```bash
git add pty-raw-write.js test/pty-raw-write.test.js
git commit -m "feat(pty): fs.writeSync с ручной частичной записью вместо p.write()"
```

---

### Task 2: `pty-write.js` — `pump()`/`send()` wait on a promise

**Files:**
- Modify: `pty-write.js:79-121` (`send`, `pump`, `push`)
- Modify: `test/pty-write.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/pty-write.test.js`, before the closing `for (const [name, fn] of tests) {...}` runner block:

```js
test('write возвращает промис — pump ждёт его перед следующей порцией', async () => {
  const scheduled = [];
  const wrote = [];
  let resolveCurrent = null;
  const w = PW.makeWriter({
    max: 4,
    schedule: (fn) => scheduled.push(fn),
    write: (key, chunk) => {
      wrote.push(chunk);
      return new Promise((resolve) => { resolveCurrent = resolve; });
    },
  });
  w.push('1', 'abcdefgh'); // режется на 'abcd' и 'efgh' при max=4
  assert.strictEqual(wrote.length, 1, 'должна уйти ровно одна порция');
  while (scheduled.length) scheduled.shift()();
  assert.strictEqual(wrote.length, 1, 'такт цикла наступил, но промис первой порции ещё не разрешился — вторая не должна уйти');
  resolveCurrent(true);
  await Promise.resolve();
  await Promise.resolve();
  while (scheduled.length) scheduled.shift()();
  assert.strictEqual(wrote.length, 2, 'после разрешения промиса и такта цикла вторая порция ушла');
});
```

- [ ] **Step 2: Change the runner to `await` each test**

Replace the runner at the end of `test/pty-write.test.js`:

```js
for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' pty-write tests passed');
```

with:

```js
(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; }
    catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
  }
  console.log(passed + '/' + tests.length + ' pty-write tests passed');
})();
```

- [ ] **Step 3: Run the tests, confirm the new one fails**

Run: `node test/pty-write.test.js`
Expected: `FAIL: write возвращает промис — pump ждёт его перед следующей порцией` (второй `wrote.length` не равен 1, потому что сегодняшний `pump()` не ждёт промис)

- [ ] **Step 4: Make `send()`/`pump()` promise-aware, in `pty-write.js`**

Replace lines 85-98 (the `send` and `pump` functions) with:

```js
  // write() либо честно возвращает true/false тем же тактом (нынешние синхронные вкладки),
  // либо отдаёт промис (частичная запись через fs.writeSync растягивается на несколько
  // тактов) — pump() не должен звать следующую порцию, пока предыдущая не долетела:
  // иначе куски одной печати обгонят друг друга в pty.
  function isThenable(v) { return !!v && typeof v.then === 'function'; }

  function send(key, chunk) {
    try { return write(key, chunk); } catch (_) { return false; }
  }

  // Одна порция за такт. Возвращает, ушла ли ЭТА порция: по первой из них вызывающий понимает,
  // напечатано ли вообще хоть что-то (вкладку могли закрыть за то время, пока текст готовился).
  // Для промиса это оптимистичное «передали в доставку» — окончательный исход синхронно
  // узнать нельзя, но такт на следующую порцию наступает только после его разрешения.
  function pump(key) {
    const parts = queues.get(key);
    if (!parts || !parts.length) { queues.delete(key); return false; }
    const result = send(key, parts.shift());
    if (isThenable(result)) {
      result.then(
        (ok) => { if (ok === false || !parts.length) queues.delete(key); else schedule(() => pump(key)); },
        () => queues.delete(key),
      );
      return true;
    }
    const ok = result !== false;
    if (!ok || !parts.length) { queues.delete(key); return ok; }
    schedule(() => pump(key));
    return true;
  }
```

- [ ] **Step 5: Update `push()`'s single-chunk fast path to match `send()`'s new raw return value**

`send()` used to coerce to boolean itself (`write(...) !== false`); now it returns the raw result so `pump()` can detect a promise. `push()`'s fast path (`if (parts.length === 1) return send(key, parts[0]);`) must do the same coercion `pump()` does. Replace:

```js
      if (parts.length === 1) return send(key, parts[0]);
```

with:

```js
      if (parts.length === 1) {
        const result = send(key, parts[0]);
        return isThenable(result) ? true : result !== false;
      }
```

- [ ] **Step 6: Run the tests, confirm all pass**

Run: `node test/pty-write.test.js`
Expected: `10/10 pty-write tests passed` (9 existing + 1 new)

- [ ] **Step 7: Commit**

```bash
git add pty-write.js test/pty-write.test.js
git commit -m "feat(pty): pump()/send() ждут промис от write(), не только boolean"
```

---

### Task 3: Wire `main.js` to `pty-raw-write.js` on POSIX

**Files:**
- Modify: `main.js:110-127`

- [ ] **Step 1: Add the require and rewrite the `write` callback**

Current (`main.js:119-127`):

```js
const ptyWrite = require('./pty-write');
const ptyOut = ptyWrite.makeWriter({
  write: (id, chunk) => {
    const p = sessions.get(id);
    if (!p) return false;                 // вкладку закрыли, пока хвост ждал такта
    p.write(chunk);
    return true;
  },
});
```

Replace with:

```js
const ptyWrite = require('./pty-write');
const rawWrite = require('./pty-raw-write');
const ptyOut = ptyWrite.makeWriter({
  write: (id, chunk) => {
    const p = sessions.get(id);
    if (!p) return false;                 // вкладку закрыли, пока хвост ждал такта
    // POSIX: пишем сами через fs.writeSync с ручной частичной записью — p.write() внутри
    // node-pty на частичной записи вешает главный поток (BUG-pty-deadlock-2026-08-11.md,
    // docs/superpowers/specs/2026-08-27-pty-raw-write-design.md). Windows (conpty) и случай,
    // когда future-версия node-pty перестанет отдавать fd, — прежним путём, без изменений.
    if (process.platform !== 'win32' && typeof p.fd === 'number') {
      const timer = setTimeout(() => {
        restartLog(`вкладка ${id}: печать подвисла, читатель не поспевает`);
      }, 3000);
      return rawWrite.writeAll(fs.writeSync, p.fd, Buffer.from(chunk, 'utf8'), setImmediate)
        .then((r) => { clearTimeout(timer); return r.ok; });
    }
    p.write(chunk);
    return true;
  },
});
```

- [ ] **Step 2: Sanity-check `fs` is already required in `main.js`**

Run: `grep -n "^const fs = require" main.js`
Expected: `24:const fs = require('fs');` (already present — no new require needed for `fs`)

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: every test passes, including `test/package-files.test.js` (will fail if `pty-raw-write.js` isn't yet in `build.files` — that's Task 4)

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(pty): вкладки на POSIX печатают через fs.writeSync, не через p.write()"
```

---

### Task 4: Package the new module

**Files:**
- Modify: `package.json` (`build.files`, `scripts.test`)

- [ ] **Step 1: Add `pty-raw-write.js` to `build.files`**

In `package.json`, find the `"pty-write.js",` line inside `build.files` and add a line right after it:

```json
      "pty-write.js",
      "pty-raw-write.js",
```

- [ ] **Step 2: Add the new test to `scripts.test`**

In `package.json`, in the `test` script string, find `&& node test/pty-write.test.js` and insert right after it:

```
 && node test/pty-raw-write.test.js
```

so that segment reads:

```
... && node test/pty-write.test.js && node test/pty-raw-write.test.js && node test/restart.test.js ...
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including `test/package-files.test.js`

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore(pty): pty-raw-write.js в build.files и scripts.test"
```

---

## Self-Review Notes

- Windows is explicitly out of scope per the design (`process.platform !== 'win32'` guard) — no task touches conpty behavior.
- The outer queueing/chunking/ordering layer in `pty-write.js` (`chunks()`, `CHUNK`, per-key queue) is untouched; only `send()`/`pump()`'s handling of `write()`'s return value changes.
- Known accepted gap (matches the approved design's scope, not fixed here): `push()`'s single-chunk fast path sends directly via `send()` without registering in the `queues` map, so two single-chunk pushes to the same key that both go async (rare — needs a nearly-full kernel tty buffer even for a ≤256-byte chunk) could in principle interleave. The design explicitly restricts changes to "how one chunk is delivered," not the outer ordering guarantees, so this is not addressed by this plan.
