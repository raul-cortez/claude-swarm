// Plain-node tests for idle-tab sleep (sleep.js).
// Ошибка в одну сторону стоит сотню мегабайт, в другую — убитую фоновую работу. Поэтому
// проверяем прежде всего каждую причину НЕ усыплять, а для сабагентов — что зависшего мы
// отличаем от живого не по экрану, а по его файлам.
const assert = require('assert');
const S = require('../sleep.js');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-21T12:00:00Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();

function tab(over) {
  return {
    enabled: true, idleMin: 30, now: NOW, activeAt: NOW - 40 * MIN, status: 'ready', bg: false,
    box: false, auto: false, agentUp: true, canResume: true, busyWith: '', watched: false,
    toolProcs: 0, ...over,
  };
}

const asst = (content, msAgo = 0) => ({ type: 'assistant', timestamp: at(msAgo), message: { content } });
const user = (content, msAgo = 0) => ({ type: 'user', timestamp: at(msAgo), message: { content } });
const text = (t) => ({ type: 'text', text: t });
const toolUse = (id, name = 'Bash', input = {}) => ({ type: 'tool_use', id, name, input });
const toolRes = (id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' });

test('минуты зажаты диапазоном, пустое — умолчание', () => {
  assert.strictEqual(S.clampMin(null), 30);
  assert.strictEqual(S.clampMin(''), 30);
  assert.strictEqual(S.clampMin('0'), S.MIN_MIN);
  assert.strictEqual(S.clampMin(1000), S.MAX_MIN);
  assert.strictEqual(S.clampMin('45'), 45);
});

test('простаивающая готовая вкладка идёт на проверку', () => {
  assert.strictEqual(S.quickDecision(tab()).act, 'check');
});

test('каждая причина не усыплять', () => {
  const cases = {
    enabled: false, auto: true, agentUp: false, canResume: false, busyWith: 'идёт перезапуск',
    status: 'running', bg: true, box: true, watched: true, toolProcs: 1,
  };
  for (const [k, v] of Object.entries(cases)) {
    assert.strictEqual(S.quickDecision(tab({ [k]: v })).act, 'wait', k);
  }
  assert.strictEqual(S.quickDecision(tab({ status: 'waiting' })).act, 'wait');
  assert.strictEqual(S.quickDecision(tab({ activeAt: NOW - 29 * MIN })).act, 'wait');
});

// Зелёная вкладка с живой фоновой командой — тот самый случай «зелёная, а в фоне работает».
test('«работает в фоне» ждёт двойной срок, а дальше идёт на проверку', () => {
  assert.strictEqual(S.quickDecision(tab({ bg: true, activeAt: NOW - 59 * MIN })).act, 'wait');
  assert.strictEqual(S.quickDecision(tab({ bg: true, activeAt: NOW - 61 * MIN })).act, 'check');
  assert.strictEqual(S.quickDecision(tab({ bg: true, activeAt: NOW - 61 * MIN, toolProcs: 1 })).act, 'wait');
});

test('живой процесс инструмента держит вкладку даже зелёной', () => {
  const r = S.quickDecision(tab({ toolProcs: 2 }));
  assert.strictEqual(r.act, 'wait');
  assert.match(r.why, /процессы/);
});

test('сабагент с отметкой finished — отработал', () => {
  assert.strictEqual(S.subagentState({ meta: { finished: true }, records: [], ageMs: 0, toolProcs: 0 }), 'done');
});

test('сабагент, сказавший последнее слово, — отработал, даже без отметки', () => {
  const recs = [asst([toolUse('t1')]), user([toolRes('t1')]), asst([text('Готово, вот отчёт')])];
  assert.strictEqual(S.subagentState({ meta: null, records: recs, ageMs: 10 * MIN, toolProcs: 0 }), 'done');
});

test('хук SubagentStop — отработал', () => {
  const recs = [asst([toolUse('t1', 'SubagentHandback')]), user([toolRes('t1')]),
    { type: 'attachment', attachment: { hookEvent: 'SubagentStop' } }];
  assert.strictEqual(S.subagentState({ meta: { finished: false }, records: recs, ageMs: 0, toolProcs: 0 }), 'done');
});

test('одно «размышление» концом не считается', () => {
  const recs = [user([toolRes('t1')]), asst([{ type: 'thinking', thinking: '' }])];
  assert.strictEqual(S.subagentState({ meta: null, records: recs, ageMs: MIN, toolProcs: 0 }), 'running');
});

test('свежие записи — работает', () => {
  const recs = [asst([toolUse('t1')])];
  assert.strictEqual(S.subagentState({ meta: null, records: recs, ageMs: MIN, toolProcs: 0 }), 'running');
});

test('долгий инструмент с живым процессом — работает', () => {
  const recs = [asst([toolUse('t1')])];
  assert.strictEqual(S.subagentState({ meta: null, records: recs, ageMs: 60 * MIN, toolProcs: 1 }), 'running');
});

test('молчит давно и ничего под ним нет — завис', () => {
  const recs = [asst([toolUse('t1')])];
  assert.strictEqual(S.subagentState({ meta: null, records: recs, ageMs: 20 * MIN, toolProcs: 0 }), 'stuck');
  assert.strictEqual(S.subagentState({ meta: null, records: [user([toolRes('t1')])], ageMs: 20 * MIN, toolProcs: 0 }), 'stuck');
});

test('молчит недолго — даём время подумать', () => {
  assert.strictEqual(S.subagentState({ meta: null, records: [user([toolRes('t1')])], ageMs: 8 * MIN, toolProcs: 0 }), 'running');
});

function deep(over) {
  return { records: [asst([text('всё')], 40 * MIN)], since: NOW - 3 * 3600 * 1000, now: NOW,
    subStates: [], trAgeMs: 40 * MIN, idleMin: 30, ...over };
}

test('всё тихо — спать', () => {
  assert.strictEqual(S.deepDecision(deep()).act, 'sleep');
});

test('зависшие сабагенты сон не держат, живые — держат', () => {
  const stuck = S.deepDecision(deep({ subStates: ['stuck', 'done'] }));
  assert.strictEqual(stuck.act, 'sleep');
  assert.match(stuck.why, /зависшие/);
  assert.strictEqual(S.deepDecision(deep({ subStates: ['stuck', 'running'] })).act, 'wait');
});

test('свежая стенограмма держит, что бы ни показывал экран', () => {
  assert.strictEqual(S.deepDecision(deep({ trAgeMs: 5 * MIN })).act, 'wait');
});

test('главный разговор ждёт инструмента — держит', () => {
  assert.strictEqual(S.deepDecision(deep({ records: [asst([toolUse('x')], 40 * MIN)] })).act, 'wait');
});

test('будильник агента в будущем держит, прошедший — нет', () => {
  const soon = [asst([toolUse('w', 'ScheduleWakeup', { delaySeconds: 3600 })], 40 * MIN), user([toolRes('w')], 40 * MIN)];
  assert.match(S.deepDecision(deep({ records: soon })).why, /будильник/);
  const past = [asst([toolUse('w', 'ScheduleWakeup', { delaySeconds: 60 })], 40 * MIN), user([toolRes('w')], 40 * MIN)];
  assert.strictEqual(S.deepDecision(deep({ records: past })).act, 'sleep');
  const stopped = [asst([toolUse('w', 'ScheduleWakeup', { delaySeconds: 3600 })], 50 * MIN), user([toolRes('w')], 50 * MIN),
    asst([toolUse('s', 'ScheduleWakeup', { stop: true })], 40 * MIN), user([toolRes('s')], 40 * MIN)];
  assert.strictEqual(S.deepDecision(deep({ records: stopped })).act, 'sleep');
});

test('расписание держит, пока не удалено; из прошлой жизни — не держит', () => {
  const cron = [asst([toolUse('c', 'CronCreate')], 40 * MIN), user([toolRes('c')], 40 * MIN)];
  assert.match(S.deepDecision(deep({ records: cron })).why, /расписани/);
  const removed = cron.concat([asst([toolUse('d', 'CronDelete')], 35 * MIN), user([toolRes('d')], 35 * MIN)]);
  assert.strictEqual(S.deepDecision(deep({ records: removed })).act, 'sleep');
  assert.strictEqual(S.deepDecision(deep({ records: cron, since: NOW - 30 * MIN })).act, 'sleep');
});

test('хвост с обрезанной первой строкой разбирается', () => {
  const recs = S.parseTail('ext":"обрезок"}\n{"type":"user","message":{"content":[]}}\n{"type":"assi');
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].type, 'user');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; } catch (e) { console.error('✗', name, '\n ', e.message); process.exitCode = 1; }
  }
  console.log(`sleep: ${passed}/${tests.length} passed`);
})();
