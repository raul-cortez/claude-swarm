// Plain-node tests for launcher detection (renderer/launch-word.js).
const assert = require('assert');
const L = require('../renderer/launch-word');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const LIST = [{ cmd: 'claude', flags: '' }, { cmd: 'my-agent', flags: '' }];

test('bare launchers are recognised by stem', () => {
  assert.strictEqual(L.launchWordFrom('claude', LIST), 'claude');
  assert.strictEqual(L.launchWordFrom('claude-my', LIST), 'claude-my');
  assert.strictEqual(L.launchWordFrom('  cld  ', LIST), 'cld');
  assert.strictEqual(L.launchWordFrom('agent', LIST), 'agent');
});

test('non-launch shell lines are ignored', () => {
  assert.strictEqual(L.launchWordFrom('ls -la', LIST), null);
  assert.strictEqual(L.launchWordFrom('git commit -m fix', LIST), null);
  assert.strictEqual(L.launchWordFrom('npm test', LIST), null);
  assert.strictEqual(L.launchWordFrom('agent smith', LIST), null);
  assert.strictEqual(L.launchWordFrom('', LIST), null);
  assert.strictEqual(L.launchWordFrom(null, LIST), null);
});

test('flags in all three forms count as a launch', () => {
  assert.strictEqual(L.launchWordFrom('claude --fork-session', LIST), 'claude');
  assert.strictEqual(L.launchWordFrom('claude --model=opus', LIST), 'claude');
  // Значение отдельным словом — из-за него `claude-my --permission-mode auto`
  // раньше не считался запуском, и вкладка не привязывалась к личному аккаунту.
  assert.strictEqual(L.launchWordFrom('claude-my --permission-mode auto', LIST), 'claude-my');
  assert.strictEqual(
    L.launchWordFrom('claude --resume 281b0332-5232-41e6-b5e7-82a8dc8564c2', LIST),
    'claude',
  );
  assert.strictEqual(L.launchWordFrom('claude -n swarm-14adfab3 --permission-mode plan', LIST), 'claude');
});

test('a prompt with spaces is not a tab launch', () => {
  assert.strictEqual(L.launchWordFrom('claude -p "сделай X"', LIST), null);
  assert.strictEqual(L.launchWordFrom('claude mcp list', LIST), null);
});

test('commands from the user list count too, flags-only tail', () => {
  assert.strictEqual(L.launchWordFrom('my-agent', LIST), 'my-agent');
  assert.strictEqual(L.launchWordFrom('my-agent --resume', LIST), 'my-agent');
  assert.strictEqual(L.launchWordFrom('my-agent smith', LIST), null);
  assert.strictEqual(L.launchWordFrom('my-agent', []), null);
});

test('alias expansion never downgrades a remembered launcher', () => {
  // ps показывает развёрнутое имя — вкладка должна остаться на своём алиасе.
  assert.strictEqual(L.isAliasExpansion('claude-my', 'claude'), true);
  assert.strictEqual(L.isAliasExpansion('claude-glm', 'claude'), true);
  assert.strictEqual(L.isAliasExpansion('/usr/local/bin/claude-my', 'claude'), true);
});

test('a real agent switch is still adopted', () => {
  assert.strictEqual(L.isAliasExpansion('claude', 'codex'), false);
  assert.strictEqual(L.isAliasExpansion('claude', 'claude-my'), false);
  assert.strictEqual(L.isAliasExpansion('claude-my', 'cld'), false);
  assert.strictEqual(L.isAliasExpansion('claude', 'claude'), false);
  assert.strictEqual(L.isAliasExpansion('', 'claude'), false);
  assert.strictEqual(L.isAliasExpansion('claude-my', ''), false);
});

// --- меню на «+»: чем открыть ЕЩЁ ОДНУ вкладку в занятой папке ----------------
const TWO = [{ cmd: 'claude', flags: '' }, { cmd: 'claude-my', flags: '' }];
const menu = (over) => L.launchMenuEntries({
  mode: 'agent', pick: 'folder', list: TWO, inherited: { cmd: 'claude', flags: '' }, ...over,
});

test('две команды — ровно два пункта, названные действием и без подсказок', () => {
  const e = menu();
  assert.strictEqual(e.length, 2);
  assert.strictEqual(e[0].label, L.NEW_TAB);
  assert.deepStrictEqual(e[0].val, {});               // пустые опции = сегодняшнее поведение
  assert.strictEqual(e[1].label, L.OTHER_SUB);
  assert.deepStrictEqual(e[1].val, { pick: true });   // рендерер откроет окно выбора
  // Имён команд под кнопкой нет ни у одного пункта — только действие.
  assert.ok(e.every((x) => x.hint === undefined));
});

test('подписок хоть десять — пунктов всё равно два, список уходит в окно выбора', () => {
  const list = ['claude', 'claude-my', 'cld', 'glm', 'codex', 'gemini', 'aider', 'qwen', 'kimi', 'droid']
    .map((cmd) => ({ cmd, flags: '' }));
  const e = menu({ list });
  assert.strictEqual(e.length, 2);
  assert.deepStrictEqual(e.map((x) => x.label), [L.NEW_TAB, L.OTHER_SUB]);
  assert.deepStrictEqual(e[1].val, { pick: true });   // рендерер откроет окно выбора
});

test('меню не всплывает там, где спросят и без него', () => {
  // Спрашивает сам resolveLaunch — иначе два вопроса подряд об одном и том же.
  assert.strictEqual(menu({ pick: 'always' }), null);
  // Папка пуста: наследовать нечего, спросит resolveLaunch (первая вкладка папки).
  assert.strictEqual(menu({ inherited: null }), null);
  // Вкладки открываются чистым терминалом — выбирать нечего.
  assert.strictEqual(menu({ mode: 'blank' }), null);
  // Одна команда в настройках — тоже не выбор.
  assert.strictEqual(menu({ list: [{ cmd: 'claude', flags: '' }] }), null);
  assert.strictEqual(menu({ list: [] }), null);
});

test('чем бы папка ни была занята, пункты одни и те же', () => {
  // Ни флаги наследованной команды, ни чистый терминал в папке меню не меняют: выбор режима
  // целиком уехал в окно, а под кнопкой всегда одна и та же пара.
  const list = [{ cmd: 'claude', flags: '--model opus' }, { cmd: 'claude-my', flags: '' }];
  for (const inherited of [
    { cmd: 'claude', flags: '--model opus' },
    { cmd: 'claude', flags: '' },
    { blank: true },
  ]) {
    const e = L.launchMenuEntries({ mode: 'agent', pick: 'folder', list, inherited });
    assert.deepStrictEqual(e.map((x) => x.label), [L.NEW_TAB, L.OTHER_SUB]);
    assert.deepStrictEqual(e[0].val, {});
    assert.deepStrictEqual(e[1].val, { pick: true });
  }
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
