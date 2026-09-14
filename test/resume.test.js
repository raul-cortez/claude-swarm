// Plain-node tests for Claude session pin/resume helpers.
const assert = require('assert');
const R = require('../renderer/resume');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('supports Claude family stems', () => {
  assert.strictEqual(R.supports('claude'), true);
  assert.strictEqual(R.supports('Claude'), true);
  assert.strictEqual(R.supports('cld'), true);
  assert.strictEqual(R.supports('claude-glm'), true);
  assert.strictEqual(R.supports('/usr/local/bin/claude'), true);
  assert.strictEqual(R.supports('codex'), false);
  assert.strictEqual(R.supports('gemini'), false);
  assert.strictEqual(R.supports('glm'), false);
});

test('newSessionKey is swarm- + 8 hex when the folder is unknown', () => {
  const k = R.newSessionKey();
  assert.match(k, /^swarm-[0-9a-f]{8}$/);
  assert.notStrictEqual(R.newSessionKey(), R.newSessionKey());
});

test('newSessionKey carries the project name — peers read it in the agent list', () => {
  assert.match(R.newSessionKey('/Users/e/WebstormProjects/fastio'), /^swarm-fastio-[0-9a-f]{8}$/);
  // Ворктри несёт номер задачи в имени каталога — значит и ключ его несёт, даром.
  assert.match(R.newSessionKey('/Users/e/WebstormProjects/fastio-686'), /^swarm-fastio-686-[0-9a-f]{8}$/);
  assert.match(R.newSessionKey('C:\\Projects\\Fastio'), /^swarm-fastio-[0-9a-f]{8}$/);
  // Хвостовой разделитель не должен съедать имя целиком.
  assert.match(R.newSessionKey('/Users/e/fastio/'), /^swarm-fastio-[0-9a-f]{8}$/);
  // Уникальность не должна пострадать: два окна на одном репозитории — обычное дело.
  assert.notStrictEqual(R.newSessionKey('/a/fastio'), R.newSessionKey('/a/fastio'));
});

test('newSessionKey falls back to bare hex when the name has nothing usable', () => {
  // Ключ уезжает в командную строку без кавычек. Нелатинское имя каталога должно исчезнуть
  // целиком, а не попасть в команду: сломанная команда открыла бы вкладку без агента.
  for (const cwd of ['/Users/e/Проекты/касса', '/', '', null, undefined, '/Users/e/!!!']) {
    assert.match(R.newSessionKey(cwd), /^swarm-[0-9a-f]{8}$/, 'cwd=' + cwd);
  }
});

test('newSessionKey keeps the project name short and free of a dangling dash', () => {
  // Имя читает человек в чужом списке сессий, поэтому оно обрезается.
  assert.match(R.newSessionKey('/a/monorepo-packages-admin-ui'), /^swarm-monorepo-packages-ad-[0-9a-f]{8}$/);
  // Обычное имя резаться не должно: на этом потолок и подняли с 16 до 20.
  assert.match(R.newSessionKey('/a/claude-swarm-lite'), /^swarm-claude-swarm-lite-[0-9a-f]{8}$/);
  // Обрез попал ровно на дефис — иначе вышло бы swarm-aaa--a3f91c2e с двойным дефисом.
  assert.match(R.newSessionKey('/a/' + 'a'.repeat(19) + '-bbb'), /^swarm-a{19}-[0-9a-f]{8}$/);
});

test('stripSessionFlags drops continue/resume/name', () => {
  assert.strictEqual(
    R.stripSessionFlags('--dangerously-skip-permissions --continue --model sonnet'),
    '--dangerously-skip-permissions --model sonnet'
  );
  assert.strictEqual(
    R.stripSessionFlags('-c --resume abc -n old --foo'),
    '--foo'
  );
  assert.strictEqual(
    R.stripSessionFlags('--resume=abc --name=old -r'),
    ''
  );
  assert.strictEqual(R.stripSessionFlags('-r uuid --keep'), '--keep');
});

test('buildCommand start pins Claude with -n', () => {
  assert.strictEqual(
    R.buildCommand({ cmd: 'claude', flags: '', sessionKey: 'swarm-deadbeef', mode: 'start' }),
    'claude -n swarm-deadbeef'
  );
  assert.strictEqual(
    R.buildCommand({
      cmd: 'cld',
      flags: '--dangerously-skip-permissions --resume junk',
      sessionKey: 'swarm-aa',
      mode: 'start',
    }),
    'cld --dangerously-skip-permissions -n swarm-aa'
  );
});

test('buildCommand resume uses --resume key', () => {
  assert.strictEqual(
    R.buildCommand({ cmd: 'claude-glm', flags: '--model opus', sessionKey: 'swarm-01', mode: 'resume' }),
    'claude-glm --model opus --resume swarm-01'
  );
});

test('buildCommand resume prefers the Claude session id over the name', () => {
  const id = '1a835121-3e5e-41ce-914f-c2805d3b9165';
  // Both known → the id wins: it reopens exactly that conversation, a name only matches
  // a session title. The -n pin is not repeated on resume.
  assert.strictEqual(
    R.buildCommand({ cmd: 'claude', flags: '', sessionKey: 'swarm-01', sessionId: id, mode: 'resume' }),
    'claude --resume ' + id
  );
  // Id alone is enough (a tab that was open before the setting was ticked).
  assert.strictEqual(
    R.buildCommand({ cmd: 'claude', flags: '--model opus', sessionId: id, mode: 'resume' }),
    'claude --model opus --resume ' + id
  );
  // Starting is unaffected: main pins the id itself, we only name the session.
  assert.strictEqual(
    R.buildCommand({ cmd: 'claude', flags: '', sessionKey: 'swarm-01', sessionId: id, mode: 'start' }),
    'claude -n swarm-01'
  );
});

test('stripSessionFlags drops --fork-session', () => {
  // Left in, it would give the resumed tab a NEW id — the saved one would go stale.
  assert.strictEqual(R.stripSessionFlags('--fork-session --model opus'), '--model opus');
});

test('buildCommand leaves non-Claude alone', () => {
  assert.strictEqual(
    R.buildCommand({ cmd: 'codex', flags: '--foo', sessionKey: 'swarm-01', mode: 'resume' }),
    'codex --foo'
  );
  assert.strictEqual(
    R.buildCommand({ cmd: 'claude', flags: '--x', sessionKey: null, mode: 'start' }),
    'claude --x'
  );
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log('ok —', name);
    } catch (err) {
      console.error('FAIL —', name);
      console.error(err);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
