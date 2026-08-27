// Пиннит то, из-за чего приложение целиком висло намертво со 100% CPU: длинный текст,
// отданный в pty вкладки одним синхронным write (BUG-pty-deadlock-2026-08-11.md).
// Проверяем два свойства, на которых всё держится, — размер порции и ПОРЯДОК печатей: между
// кусками управление уходит циклу событий, и в этот зазор просится и Enter от телеграма, и
// клавиша из-под руки. Кусок, пролезший не в свою очередь, — это мусор в промпте агента.
// Run: node test/pty-write.test.js
const assert = require('assert');
const PW = require('../pty-write');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// Насос с расписанием в руках теста: порции уезжают только когда мы это разрешим — так видно,
// что уехало синхронно, а что ждало такта.
function harness(opts = {}) {
  const wrote = [];
  const pending = [];
  const dead = new Set();
  const w = PW.makeWriter({
    max: opts.max || 8,
    schedule: (fn) => pending.push(fn),
    write: (key, chunk) => {
      if (dead.has(key)) return false;
      if (opts.throwOn && opts.throwOn === chunk) throw new Error('pty closed');
      wrote.push([key, chunk]);
      return true;
    },
  });
  return {
    w, wrote, dead,
    // Прокрутить цикл до конца, как это сделал бы setImmediate.
    flush(limit = 1000) {
      let n = 0;
      while (pending.length && n++ < limit) pending.shift()();
    },
    text(key) { return wrote.filter(([k]) => k === key).map(([, c]) => c).join(''); },
  };
}

test('порции не длиннее потолка, а склеенные — тот же текст', () => {
  const src = 'claude --permission-mode acceptEdits ' + 'ж'.repeat(300);
  const parts = PW.chunks(src, 256);
  assert.ok(parts.length > 2, 'на килобайте порций должно быть много: ' + parts.length);
  for (const p of parts) assert.ok(PW.byteLength(p) <= 256, 'порция в байтах: ' + PW.byteLength(p));
  assert.strictEqual(parts.join(''), src);
});

test('сурогатная пара не разрывается границей порции', () => {
  // 🙂 — четыре байта UTF-8. При потолке, который приходится ровно на её середину, кусок
  // обязан УЙТИ ЦЕЛИКОМ в следующую порцию: половина пары доедет знаком вопроса.
  const src = 'aa🙂bb';
  for (const max of [1, 2, 3, 4, 5, 6]) {
    const parts = PW.chunks(src, max);
    assert.strictEqual(parts.join(''), src, 'max=' + max);
    for (const p of parts) {
      assert.ok(!/[\uD800-\uDBFF]$/.test(p), 'обрубок пары в конце порции, max=' + max);
      assert.ok(!/^[\uDC00-\uDFFF]/.test(p), 'обрубок пары в начале порции, max=' + max);
    }
  }
});

test('нечего печатать — нет и порций', () => {
  for (const empty of ['', null, undefined]) assert.deepStrictEqual(PW.chunks(empty, 8), []);
});

test('длинный текст уезжает по такту, а не одним write', () => {
  const h = harness({ max: 8 });
  assert.strictEqual(h.w.push('1', 'abcdefghijklmnopqrstuvwx'), true);
  // Первая порция ушла сразу — иначе набор текста ждал бы такта цикла.
  assert.strictEqual(h.wrote.length, 1, 'синхронно должна уйти ровно одна порция');
  assert.strictEqual(h.w.pending('1'), 2);
  h.flush();
  assert.strictEqual(h.text('1'), 'abcdefghijklmnopqrstuvwx');
  assert.strictEqual(h.w.pending('1'), 0);
});

test('короткая печать уходит синхронно и без очереди', () => {
  const h = harness({ max: 8 });
  assert.strictEqual(h.w.push('1', '\x1b'), true);   // Escape по кнопке из чата
  assert.deepStrictEqual(h.wrote, [['1', '\x1b']]);
  assert.strictEqual(h.w.pending('1'), 0);
});

test('печать, пришедшая посреди порций, встаёт В ХВОСТ, а не в середину слова', () => {
  const h = harness({ max: 4 });
  h.w.push('1', 'прочитай эстафету');   // длинная: поехала по кускам
  h.w.push('1', '\r');                  // Enter от телеграма — отдельной печатью, через 90 мс
  h.flush();
  assert.strictEqual(h.text('1'), 'прочитай эстафету\r');
});

// По ответу push вызывающий решает, случилось ли событие: запуск вкладки на этом ставит отметку
// времени, а телеграм — «напечатал». Соврать здесь значит записать в журнал то, чего не было.
test('вкладки уже нет — push честно отвечает «не напечатал»', () => {
  const h = harness({ max: 4 });
  h.dead.add('1');
  assert.strictEqual(h.w.push('1', 'короткая'), false, 'длинный текст');
  assert.strictEqual(h.w.push('1', 'кор'), false, 'одна порция');
  assert.strictEqual(h.w.pending('1'), 0);
});

test('вкладка умерла — хвост выбрасывается, а не досылается в закрытый pty', () => {
  const h = harness({ max: 4 });
  h.w.push('1', 'длинная строка запуска');
  const sent = h.wrote.length;
  h.dead.add('1');
  h.flush();
  assert.strictEqual(h.wrote.length, sent, 'после отказа write порции продолжали уезжать');
  assert.strictEqual(h.w.pending('1'), 0);
});

test('исключение из pty гасит очередь так же, как отказ', () => {
  const h = harness({ max: 4, throwOn: 'efgh' });
  h.w.push('1', 'abcdefghijkl');
  h.flush();
  assert.strictEqual(h.text('1'), 'abcd');
  assert.strictEqual(h.w.pending('1'), 0);
});

test('drop убирает очередь закрытой вкладки', () => {
  const h = harness({ max: 4 });
  h.w.push('1', 'abcdefghijkl');
  h.w.drop('1');
  h.flush();
  assert.strictEqual(h.text('1'), 'abcd');
  assert.strictEqual(h.w.pending('1'), 0);
});

test('вкладки не перемешиваются между собой', () => {
  const h = harness({ max: 4 });
  h.w.push('1', 'ААААББББВВВВ');
  h.w.push('2', 'ссссддддееее');
  h.flush();
  assert.strictEqual(h.text('1'), 'ААААББББВВВВ');
  assert.strictEqual(h.text('2'), 'ссссддддееее');
});

// pty-raw-write.js делает частичную запись руками, и результат write() теперь может
// растянуться на несколько тактов цикла — pump() обязан дождаться промиса ПРЕДЫДУЩЕЙ
// порции, прежде чем отдавать вкладке следующую, иначе куски одной печати обгонят друг
// друга. docs/superpowers/specs/2026-08-27-pty-raw-write-design.md.
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

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; }
    catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
  }
  console.log(passed + '/' + tests.length + ' pty-write tests passed');
})();
