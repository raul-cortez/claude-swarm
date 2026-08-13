// Pins the hooks block written into swarm-settings.json: the event names must match
// what Claude Code fires AND what hooks/swarm-signal.mjs handles, or a signal
// silently never arrives.
const assert = require('assert');
const { hookSettings } = require('../hook-config');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const CMD = 'sh "/tmp/launcher.sh"';

test('registers exactly the events swarm-signal.mjs handles', () => {
  const events = Object.keys(hookSettings(CMD)).sort();
  assert.deepStrictEqual(events,
    ['Notification', 'PermissionRequest', 'PostToolUse', 'PreToolUse', 'Stop', 'SubagentStop',
      'UserPromptSubmit'].sort());
});

test('every event points a command hook at the given launcher', () => {
  const s = hookSettings(CMD);
  for (const ev of Object.keys(s)) {
    const h = s[ev][0].hooks[0];
    assert.strictEqual(h.type, 'command', ev + ' is a command hook');
    assert.strictEqual(h.command, CMD, ev + ' uses our launcher');
  }
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' hook-config tests passed');
