// Pins the rule we teach the agent (agent-rules.js). Two classes of bug here, both
// invisible at runtime: a rule that names a phrase the matcher doesn't look for (the
// status silently never flips to «ждёт ответа»), and a rule that breaks the launch
// command line it's embedded into (the tab dies before claude starts).
// Run: node test/agent-rules.test.js
const assert = require('assert');
const AR = require('../agent-rules');
const AP = require('../ask-phrases');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('the default marker is the phrase the matcher ships with', () => {
  // Duplicated constant (agent-rules is also loaded as a plain script, no require),
  // so it has to be pinned: teaching a phrase nobody matches breaks the status.
  assert.strictEqual(AR.DEFAULT_MARKER, AP.DEFAULT_ASK_PHRASES[0]);
});

test('both rules teach a sign-off the matcher actually accepts as a call', () => {
  for (const phrases of [[], ['Твой ход'], ['  Нужен ответ  ', 'Твой ход']]) {
    const m = AP.buildAskMatcher(phrases);
    const marker = AR.markerOf(phrases);
    // The rule's own example line, as the agent would write it.
    const sample = `Сделал то и это.\n\n${marker}: путь к схеме`;
    assert.ok(AP.asksWith(m, sample), 'calls with ' + JSON.stringify(phrases));
    for (const rule of [AR.systemPromptRule(phrases), AR.claudeMdRule(phrases)]) {
      assert.ok(rule.includes(marker), 'rule names the marker: ' + JSON.stringify(phrases));
      assert.ok(/AskUserQuestion/.test(rule), 'rule asks for the tool too');
    }
  }
});

test('the «ничего, жди» escape hatch we document is really not a call', () => {
  const m = AP.buildAskMatcher([]);
  assert.ok(!AP.asksWith(m, `${AR.DEFAULT_MARKER}: ничего, жди результата`));
});

test('обе строки правила про фон дают ровно «работает в фоне»', () => {
  // Правило учит третьей концовке — «ничего, жду …», ждёт АГЕНТ. Если она разъедется с
  // матчером, вкладка с живой фоновой задачей снова станет зелёной, и увидеть это можно
  // будет только вживую: тесты по обе стороны останутся зелёными.
  for (const phrases of [[], ['Твой ход'], ['Нужен ответ', 'Твой ход']]) {
    const m = AP.buildAskMatcher(phrases);
    const marker = AR.markerOf(phrases);
    const sample = `Запустил замер.\n\n${marker}: ничего, жду замер стенда`;
    assert.ok(AP.waitsWith(m, sample), 'фон с ' + JSON.stringify(phrases));
    assert.ok(!AP.asksWith(m, sample), 'и это не зов: ' + JSON.stringify(phrases));
    for (const rule of [AR.systemPromptRule(phrases), AR.claudeMdRule(phrases)]) {
      assert.ok(/жду/.test(rule), 'правило называет слово: ' + JSON.stringify(phrases));
    }
  }
});

test('the system-prompt rule is one line and safe inside a shell "…"', () => {
  // Main normally passes it through the environment, but for a shell whose syntax it
  // doesn't know it spells the value inline on a command line it WRITES INTO AN
  // INTERACTIVE SHELL — there a newline would end the command and a quote/$/`/! would
  // swallow the rest of it.
  for (const phrases of [[], ['ой "кавычки" и $HOME'], ["it's `date`"], ['!!'], ['a\nb']]) {
    const rule = AR.systemPromptRule(phrases);
    assert.ok(!/\n/.test(rule), 'single line: ' + JSON.stringify(phrases));
    assert.ok(!/["'`$\\!]/.test(rule), 'no shell metacharacters: ' + JSON.stringify(phrases));
  }
});

test('a phrase made only of unsafe characters falls back to the default', () => {
  assert.strictEqual(AR.markerOf(['"$!`']), AR.DEFAULT_MARKER);
  assert.strictEqual(AR.markerOf([null, '', '   ']), AR.DEFAULT_MARKER);
});

test('the CLAUDE.md block is fenced so it can be replaced whole', () => {
  const md = AR.claudeMdRule([]);
  assert.ok(md.startsWith(AR.MD_BEGIN), 'starts with the begin marker');
  assert.ok(md.trimEnd().endsWith(AR.MD_END), 'ends with the end marker');
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' agent-rules tests passed');
