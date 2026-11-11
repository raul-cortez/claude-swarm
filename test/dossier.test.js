// Plain-node tests for the tab dossier helpers (dossier.js).
// The shapes of queue entries are taken from a live stand (Claude Code 2.1.322, 2026-11-11):
// a message typed into a busy agent is logged at once as `queue-operation enqueue`; on
// delivery come `operation: remove` and an `attachment.type: queued_command`.
const assert = require('assert');
const D = require('../dossier.js');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const t = (s) => `2026-11-11T10:00:${String(s).padStart(2, '0')}.000Z`;
const ms = (s) => Date.parse(t(s));
const human = (s, text) => ({ type: 'user', timestamp: t(s), message: { role: 'user', content: text } });
const agent = (s, text, tools = 0) => ({
  type: 'assistant', timestamp: t(s),
  message: { content: [{ type: 'text', text }, ...Array.from({ length: tools }, () => ({ type: 'tool_use', name: 'Bash' }))] },
});
const enqueue = (s, text) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: t(s), content: text });
const remove = (s, text) => ({ type: 'queue-operation', operation: 'remove', timestamp: t(s), content: text });
const queued = (s, text) => ({ type: 'attachment', timestamp: t(s), attachment: { type: 'queued_command', prompt: text } });

test('safeKey keeps folder names plain', () => {
  assert.strictEqual(D.safeKey('tab/1 x'), 'tab_1_x');
  assert.strictEqual(D.safeKey(null), '');
});

test('fresh templates are blank, a written line is not', () => {
  const tp = D.templates();
  assert.ok(D.isBlank(tp.dossier, 'dossier'));
  assert.ok(D.isBlank(tp.work, 'work'));
  assert.ok(!D.isBlank(tp.dossier.replace('- Цель:', '- Цель: перевести настройки'), 'dossier'));
  assert.ok(!D.isBlank(tp.dossier + '\n- Не трогать payload. (человек, 11.11)\n', 'dossier'));
});

test('parseLines keeps every type and skips broken lines', () => {
  const text = [JSON.stringify(enqueue(1, 'x')), '{broken', '', JSON.stringify(human(2, 'hi'))].join('\n');
  const es = D.parseLines(text);
  assert.strictEqual(es.length, 2);
  assert.strictEqual(es[0].type, 'queue-operation');
});

test('undelivered: enqueue without removal survives, delivered one does not', () => {
  const es = [enqueue(1, 'A'), enqueue(2, 'B'), remove(5, 'A'), queued(5, 'A')];
  assert.deepStrictEqual(D.undelivered(es).map((u) => u.text), ['B']);
});

test('undelivered: two identical texts — one removal cancels one copy', () => {
  const es = [enqueue(1, 'да'), enqueue(2, 'да'), remove(3, 'да')];
  assert.strictEqual(D.undelivered(es).length, 1);
});

test('undelivered: unknown bare removal clears all pending', () => {
  assert.strictEqual(D.undelivered([enqueue(1, 'A'), enqueue(2, 'B'), { type: 'queue-operation', operation: 'popAll', timestamp: t(3) }]).length, 0);
});

// Live shape (this repo's transcript, 2026-11-11): background notices share the queue, and
// `dequeue` is written without content.
const bareDequeue = (s) => ({ type: 'queue-operation', operation: 'dequeue', timestamp: t(s), content: '' });
test('undelivered: a bare dequeue takes the front, whatever it is (measured order)', () => {
  // delivered in turn: the notice first, then the person
  assert.deepStrictEqual(D.undelivered([enqueue(1, '<task-notification>x'), enqueue(2, 'ответь мне'), bareDequeue(3)]).map((u) => u.text), ['ответь мне']);
  // the person was at the front — it's the person who got delivered
  assert.deepStrictEqual(D.undelivered([enqueue(1, 'ответь мне'), enqueue(2, '<task-notification>x'), bareDequeue(3)]).map((u) => u.text), []);
  // two typed, one delivered
  assert.deepStrictEqual(D.undelivered([enqueue(1, 'раз'), enqueue(2, 'два'), bareDequeue(3)]).map((u) => u.text), ['два']);
});

test('undelivered: crew texts are kept and signed, the restart ask is not', () => {
  const es = [enqueue(1, '[сворм] Вопрос от исполнителя «a»: можно?'), enqueue(2, '[сворм] Контекст этой вкладки заполнен на 30%')];
  assert.deepStrictEqual(D.undelivered(es).map((u) => [u.who, u.text.slice(0, 12)]), [['swarm', '[сворм] Вопр']]);
  const txt = D.inheritText({ how: 'restart', undelivered: D.undelivered(es), tail: { items: [], dropped: 0 } });
  assert.ok(txt.includes('**Сворм**'));
});

test('the restart ask pattern matches what restart.js actually types', () => {
  const R = require('../restart.js');
  assert.strictEqual(D.kindOf(R.askText({ pct: 30, answerFile: '/x' })), 'restart');
  assert.strictEqual(D.kindOf(R.askAgainText({ pct: 30, answerFile: '/x' })), 'restart');
  assert.strictEqual(D.kindOf('<pasted_content id="1">\n' + R.askText({ pct: 30, answerFile: '/x' })), 'restart');
});

test('splitLines keeps a letter cut at the boundary intact', () => {
  const line = Buffer.from(JSON.stringify(human(1, 'Привет')) + '\n' + JSON.stringify(human(2, 'мир')) + '\n');
  const at = line.indexOf(Buffer.from('мир')) + 1;   // inside the two-byte «м»
  const a = D.splitLines(null, line.subarray(0, at));
  const b = D.splitLines(a.rest, line.subarray(at));
  const texts = D.parseLines(a.text + '\n' + b.text).map((e) => e.message.content);
  assert.deepStrictEqual(texts, ['Привет', 'мир']);
  assert.strictEqual(b.rest.length, 0);
});

test('undelivered: notices are not handed over', () => {
  const es = [enqueue(1, '<task-notification>x'), enqueue(2, '<agent-message from="a">hi</agent-message>'), enqueue(5, 'моё')];
  assert.deepStrictEqual(D.undelivered(es).map((u) => u.text), ['моё']);
});

test('humanMessage: prompts and queued commands count, noise does not', () => {
  assert.ok(D.humanMessage(human(1, 'сделай X')));
  assert.ok(D.humanMessage(queued(1, 'и ещё Y')));
  assert.strictEqual(D.humanMessage({ ...human(1, 'meta'), isMeta: true }), null);
  assert.strictEqual(D.humanMessage({ ...human(1, 'sub'), isSidechain: true }), null);
  assert.strictEqual(D.humanMessage(human(1, '[Request interrupted by user]')), null);
  assert.strictEqual(D.humanMessage(human(1, '<local-command-stdout>ok</local-command-stdout>')), null);
  assert.strictEqual(D.humanMessage({ type: 'user', timestamp: t(1), message: { content: [{ type: 'tool_result', content: 'x' }] } }), null);
});

test('humanMessage: origin other than human, notices, swarm texts are not the person', () => {
  assert.strictEqual(D.humanMessage({ ...human(1, 'x'), origin: { kind: 'task-notification' } }), null);
  assert.ok(D.humanMessage({ ...human(1, 'x'), origin: { kind: 'human' } }));
  assert.strictEqual(D.humanMessage(human(1, '[сворм] Контекст этой вкладки заполнен на 30%')), null);
  assert.strictEqual(D.humanMessage(human(1, '\n\n<pasted_content id="6d74">\n[сворм] Контекст')), null);
  assert.strictEqual(D.humanMessage(queued(1, '<task-notification>\n<task-id>a</task-id>')), null);
  assert.strictEqual(D.humanMessage({ ...queued(1, 'x'), origin: { kind: 'task-notification' } }), null);
});

test('humanMessage: slash command is shown as typed', () => {
  const h = D.humanMessage(human(1, '<command-name>/task</command-name>\n<command-args>https://x/1</command-args>'));
  assert.strictEqual(h.text, '/task https://x/1');
});

test('humanCountAfter counts only after the mark', () => {
  const es = [human(1, 'a'), agent(2, 'ok'), human(3, 'b'), queued(4, 'c')];
  assert.strictEqual(D.humanCountAfter(es, 0), 3);
  assert.strictEqual(D.humanCountAfter(es, ms(2)), 2);
});

test('tailAfter: both voices after the mark, in order', () => {
  const es = [human(1, 'old'), agent(2, 'old answer'), human(3, 'new rule'), agent(4, 'noted')];
  const { items } = D.tailAfter(es, ms(2));
  assert.deepStrictEqual(items.map((x) => [x.who, x.text]), [['human', 'new rule'], ['agent', 'noted']]);
});

test('tailAfter: over the cap the agent prose goes first, human words stay', () => {
  const long = 'x'.repeat(3000);
  const es = [agent(1, long), human(2, 'keep me'), agent(3, long), human(4, 'and me')];
  const { items, dropped } = D.tailAfter(es, 0, 3500);
  assert.ok(dropped >= 1);
  assert.ok(items.filter((x) => x.who === 'human').length === 2);
});

test('tailAfter: one huge human message is cut from the head', () => {
  const { items } = D.tailAfter([human(1, 'A'.repeat(5000) + 'THE ASK')], 0, 1000);
  assert.ok(items[0].text.endsWith('THE ASK'));
  assert.ok(items[0].text.startsWith('…'));
});

test('toolCallsAfter counts main-thread tool calls after a moment', () => {
  const es = [agent(1, 'a', 2), agent(5, 'b', 3), { ...agent(6, 'sub', 4), isSidechain: true }];
  assert.strictEqual(D.toolCallsAfter(es, ms(2)), 3);
});

test('inheritText: undelivered first, tail quoted, crash wording', () => {
  const txt = D.inheritText({
    how: 'crash', at: ms(9), undelivered: [{ at: ms(8), text: 'ответь на вопрос' }],
    tail: { items: [{ who: 'human', at: ms(3), text: 'правило' }], dropped: 0 }, workStale: 4, workAt: ms(1),
  });
  assert.ok(/упала/.test(txt));
  assert.ok(txt.indexOf('Недоставленное') < txt.indexOf('Хвост'));
  assert.ok(txt.includes('> ответь на вопрос'));
  assert.ok(txt.includes('4 вызовов'));
});

test('inheritText: empty tail says so', () => {
  const txt = D.inheritText({ how: 'restart', tail: { items: [], dropped: 0 } });
  assert.ok(/перезапустилась/.test(txt));
  assert.ok(/Пусто/.test(txt));
  assert.ok(!/Недоставленное/.test(txt));
});

test('sweepPlan: quiet orphans to archive, recent ones wait, live untouched', () => {
  const now = Date.parse('2026-12-31T00:00:00Z');
  const old = now - 2 * 86400000;
  const p = D.sweepPlan({
    now, liveKeys: ['k1'],
    dirs: [{ key: 'k1', mtimeMs: old }, { key: 'k2', mtimeMs: old }, { key: 'k5', mtimeMs: now - 3600000 }, { key: 'archive', mtimeMs: old }],
    archived: [],
  });
  assert.deepStrictEqual(p.toArchive, ['k2']);
});

test('sweepPlan: archive age from the name stamp, not the folder mtime', () => {
  const now = Date.parse('2026-12-31T00:00:00Z');
  const fresh = D.archiveName('k9', Date.parse('2026-12-25T10:00:00Z'));
  const stale = D.archiveName('k8', Date.parse('2026-11-01T10:00:00Z'));
  assert.strictEqual(D.archivedAt(fresh), Date.parse('2026-12-25T10:00:00Z'));
  const p = D.sweepPlan({ now, liveKeys: [], dirs: [],
    archived: [{ name: fresh, mtimeMs: Date.parse('2026-01-01T00:00:00Z') }, { name: stale, mtimeMs: now }] });
  assert.deepStrictEqual(p.toDelete, [stale]);
});

test('compact keeps text, queue ops and tool_use stubs, drops tool bulk', () => {
  assert.strictEqual(D.compact({ type: 'user', timestamp: t(1), message: { content: [{ type: 'tool_result', content: 'huge' }] } }), null);
  const a = D.compact({ type: 'assistant', timestamp: t(2), message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'hi' }, { type: 'tool_use', input: { big: 'x'.repeat(1000) } }] } });
  assert.deepStrictEqual(a.message.content, [{ type: 'text', text: 'hi' }, { type: 'tool_use' }]);
  assert.strictEqual(D.compact({ type: 'attachment', attachment: { type: 'hook_success' } }), null);
  assert.strictEqual(D.compact(enqueue(1, 'A')).content, 'A');
  assert.strictEqual(D.toolCallsAfter([a], 0), 1);
});

test('historyPrune keeps the newest five', () => {
  const names = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07'].map((n) => n + '.md');
  assert.deepStrictEqual(D.historyPrune(names), ['2026-01-01.md', '2026-01-02.md']);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; } catch (e) { console.error('✗', name); throw e; }
}
console.log(`dossier: ${passed}/${tests.length} ok`);
