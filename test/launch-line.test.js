// Pins how swarm spells its own flags in the line it types into a tab (launch-line.js).
// The bug class here is silent in review and loud in use: a reference the tab's shell
// doesn't expand hands claude a literal `$SWARM_ASK_RULE` as its system prompt, or a
// --settings path that doesn't exist — and claude then refuses to start, so the tab
// opens on a dead shell instead of an agent.
// Run: node test/launch-line.test.js
const assert = require('assert');
const LL = require('../launch-line');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('the shells we ship on are recognised, by full path and on Windows', () => {
  assert.strictEqual(LL.shellFamily('/bin/zsh'), 'posix');
  assert.strictEqual(LL.shellFamily('/opt/homebrew/bin/fish'), 'posix');
  assert.strictEqual(LL.shellFamily('C:\\Windows\\System32\\cmd.exe'), 'cmd');
  assert.strictEqual(LL.shellFamily('C:\\...\\WindowsPowerShell\\v1.0\\powershell.EXE'), 'powershell');
  assert.strictEqual(LL.shellFamily('/usr/local/bin/pwsh'), 'powershell');
});

test('an unfamiliar shell is admitted as unknown instead of guessed', () => {
  // Guessing is what breaks the tab; these expand variables their own way.
  for (const sh of ['/opt/homebrew/bin/nu', '/usr/bin/xonsh', '/bin/elvish', '', null]) {
    assert.strictEqual(LL.shellFamily(sh), null, 'unknown: ' + sh);
  }
});

test('a known shell gets a reference, and the value goes to the environment', () => {
  const cases = {
    '/bin/zsh': '"$SWARM_ASK_RULE"',
    'cmd.exe': '"%SWARM_ASK_RULE%"',
    'pwsh': '"$env:SWARM_ASK_RULE"',
  };
  for (const [sh, expected] of Object.entries(cases)) {
    const pass = LL.envPassing(sh);
    assert.strictEqual(pass.ref('SWARM_ASK_RULE', 'делай так'), expected, sh);
    assert.strictEqual(pass.env.SWARM_ASK_RULE, 'делай так', sh + ' env');
  }
});

test('an unknown shell gets the value inline and nothing in the environment', () => {
  const pass = LL.envPassing('/opt/homebrew/bin/nu');
  assert.strictEqual(pass.ref('SWARM_ASK_RULE', 'делай так'), '"делай так"');
  assert.deepStrictEqual(pass.env, {}, 'a variable it would never expand is not set');
});

test('several values collect side by side in one environment', () => {
  const pass = LL.envPassing('/bin/bash');
  const a = pass.ref('SWARM_SETTINGS', '/Users/me/Application Support/swarm-settings.json');
  const b = pass.ref('SWARM_ASK_RULE', 'правило');
  assert.strictEqual(a, '"$SWARM_SETTINGS"');
  assert.strictEqual(b, '"$SWARM_ASK_RULE"');
  assert.deepStrictEqual(Object.keys(pass.env).sort(), ['SWARM_ASK_RULE', 'SWARM_SETTINGS']);
});

test('the line stays short: nothing of a long value shows up in it', () => {
  // The whole point. A 500-character rule inline is six wrapped lines in a fresh tab.
  const rule = 'ж'.repeat(500);
  const spelled = LL.envPassing('/bin/zsh').ref('SWARM_ASK_RULE', rule);
  assert.ok(spelled.length < 30, 'reference, not the text: ' + spelled.length + ' chars');
  assert.ok(!spelled.includes('ж'), 'the text itself is not on the line');
});

test('the screen wipe speaks each shell own way and still runs the command', () => {
  assert.strictEqual(LL.clearPrefix('/bin/zsh'), 'clear; ');
  assert.strictEqual(LL.clearPrefix('/opt/homebrew/bin/nu'), 'clear; ');
  assert.strictEqual(LL.clearPrefix('powershell.exe'), 'clear; ');
  assert.strictEqual(LL.clearPrefix('cmd.exe'), 'cls&');
  // A separator, not `&&`: if `clear` is missing, the agent must still start.
  for (const sh of ['/bin/zsh', 'cmd.exe']) {
    assert.ok(!/&&/.test(LL.clearPrefix(sh)), 'no short-circuit for ' + sh);
  }
});

test('tabEnv стирает метки Клод-сессии, запустившей сворм', () => {
  const parent = {
    PATH: '/usr/bin',
    CLAUDE_CODE_CHILD_SESSION: '1',      // из-за неё Клод не пишет журнал
    CLAUDE_CODE_SESSION_ID: 'abc',
    CLAUDECODE: '1',
    CLAUDE_PID: '123',
  };
  const env = LL.tabEnv(parent);
  for (const k of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_PID']) {
    assert.ok(!(k in env), k + ' должна быть стёрта');
  }
  assert.strictEqual(env.PATH, '/usr/bin');
  // Родительское окружение не трогаем: process.env принадлежит не нам.
  assert.strictEqual(parent.CLAUDE_CODE_CHILD_SESSION, '1');
});

test('tabEnv не трогает авторизацию и выбор аккаунта', () => {
  const env = LL.tabEnv({
    CLAUDE_CONFIG_DIR: '/Users/x/.claude-my',   // на этом держится алиас личного аккаунта
    ANTHROPIC_API_KEY: 'sk-xxx',
    ANTHROPIC_BASE_URL: 'https://example',
    SHELL: '/bin/zsh',
  });
  assert.strictEqual(env.CLAUDE_CONFIG_DIR, '/Users/x/.claude-my');
  assert.strictEqual(env.ANTHROPIC_API_KEY, 'sk-xxx');
  assert.strictEqual(env.ANTHROPIC_BASE_URL, 'https://example');
  assert.strictEqual(env.SHELL, '/bin/zsh');
});

test('normalizeProxy: пусто и мусор — не вмешиваться, схема по умолчанию http', () => {
  assert.strictEqual(LL.normalizeProxy(''), '');
  assert.strictEqual(LL.normalizeProxy('   '), '');
  assert.strictEqual(LL.normalizeProxy(null), '');
  assert.strictEqual(LL.normalizeProxy('http://'), '');
  assert.strictEqual(LL.normalizeProxy('ftp://host:21'), '');
  assert.strictEqual(LL.normalizeProxy(' proxy.corp:3128 '), 'http://proxy.corp:3128');
  assert.strictEqual(LL.normalizeProxy('http://user:p%40ss@10.0.0.1:8080'), 'http://user:p%40ss@10.0.0.1:8080');
  assert.strictEqual(LL.normalizeProxy('https://proxy.corp'), 'https://proxy.corp');
});

test('proxyEnv ставит все четыре переменные и не трогает исходное окружение', () => {
  const base = { PATH: '/usr/bin' };
  const env = LL.proxyEnv(base, 'http://u:p@h:8080');
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    assert.strictEqual(env[k], 'http://u:p@h:8080', k);
  }
  assert.strictEqual(env.PATH, '/usr/bin');
  assert.ok(!('HTTP_PROXY' in base), 'исходный объект не меняется');
  assert.strictEqual(env.NO_PROXY, 'localhost,127.0.0.1,::1');
});

test('proxyEnv дополняет свой NO_PROXY человека, а не затирает', () => {
  const env = LL.proxyEnv({ NO_PROXY: 'git.corp, localhost' }, 'h:1');
  assert.strictEqual(env.NO_PROXY, 'git.corp,localhost,127.0.0.1,::1');
  assert.strictEqual(env.no_proxy, env.NO_PROXY);
});

test('proxyEnv без прокси оставляет системные переменные как есть', () => {
  const env = LL.proxyEnv({ HTTPS_PROXY: 'http://sys:1' }, '');
  assert.strictEqual(env.HTTPS_PROXY, 'http://sys:1');
  assert.ok(!('NO_PROXY' in env));
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' launch-line tests passed');
