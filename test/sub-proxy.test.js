// Прокси подписки в её собственных настройках (sub-proxy.js). Ошибка здесь не видна, пока
// подписку не запустят руками: «личная» тогда молча выходит в сеть с адреса мака, рабочая —
// через чужой прокси, а настройки человека, которые мы трогали, назад не возвращаются.
// Run: node test/sub-proxy.test.js
const assert = require('assert');
const SP = require('../sub-proxy');
const { normalizeProxy } = require('../launch-line');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const PX = 'http://u:p@1.2.3.4:8080';
const CARDS = [
  { line: 'claude-my --permission-mode auto', home: '/h/.claude-my' },
  { line: 'claude --model opus', home: '/h/.claude' },
  { line: 'claude-new', home: '' },
];

test('a subscription with a proxy gets its address, the others go direct explicitly', () => {
  const w = SP.wanted(CARDS, [{ line: 'claude-my', proxy: PX }], normalizeProxy);
  assert.strictEqual(w.get('/h/.claude-my'), PX);
  assert.strictEqual(w.get('/h/.claude'), '');
  assert.ok(!w.has(''), 'a card whose folder is unknown is left alone');
});

test('nobody has a proxy — nothing to enforce', () => {
  assert.strictEqual(SP.wanted(CARDS, [], normalizeProxy).size, 0);
  assert.strictEqual(SP.wanted(CARDS, [{ line: 'claude-my', proxy: 'socks5://x:1' }], normalizeProxy).size, 0);
});

test('two cards of one folder: a proxy on either one is the folder\'s proxy', () => {
  const cards = [{ line: 'claude', home: '/h/.c' }, { line: 'claude-p --x', home: '/h/.c' }];
  const w = SP.wanted(cards, [{ line: 'claude-p', proxy: PX }], normalizeProxy);
  assert.strictEqual(w.get('/h/.c'), PX);
});

test('writing a proxy keeps the rest of the settings and merges NO_PROXY', () => {
  const r = SP.apply({ model: 'opus', env: { FOO: '1', NO_PROXY: 'corp.local' } }, PX, {});
  assert.ok(r.changed);
  assert.strictEqual(r.settings.model, 'opus');
  assert.strictEqual(r.settings.env.FOO, '1');
  for (const k of SP.PROXY_KEYS) assert.strictEqual(r.settings.env[k], PX);
  assert.strictEqual(r.settings.env.NO_PROXY, 'corp.local,localhost,127.0.0.1,::1');
  assert.strictEqual(r.settings.env.no_proxy, 'localhost,127.0.0.1,::1');
});

test('releasing puts back exactly what was there before', () => {
  const before = { env: { FOO: '1', NO_PROXY: 'corp.local' } };
  const a = SP.apply(before, PX, {});
  const b = SP.apply(a.settings, null, a.owned);
  assert.deepStrictEqual(b.settings, before);
  assert.deepStrictEqual(b.owned, {});
  const c = SP.apply(SP.apply({}, PX, {}).settings, null, SP.apply({}, PX, {}).owned);
  assert.deepStrictEqual(c.settings, {}, 'an env block we created goes away with us');
});

test('a value the person changed after us stays theirs', () => {
  const a = SP.apply({}, PX, {});
  const edited = { env: Object.assign({}, a.settings.env, { HTTPS_PROXY: 'http://mine:1' }) };
  const b = SP.apply(edited, null, a.owned);
  assert.strictEqual(b.settings.env.HTTPS_PROXY, 'http://mine:1');
  assert.ok(!('HTTP_PROXY' in b.settings.env));
});

test('changing the address keeps the original "before", not our previous write', () => {
  const a = SP.apply({ env: { HTTPS_PROXY: 'http://old:1' } }, PX, {});
  const b = SP.apply(a.settings, 'http://other:2', a.owned);
  assert.strictEqual(b.settings.env.HTTPS_PROXY, 'http://other:2');
  const c = SP.apply(b.settings, null, b.owned);
  assert.deepStrictEqual(c.settings, { env: { HTTPS_PROXY: 'http://old:1' } });
});

test('direct: empty values shut out the shell\'s proxy, a hand-written one is respected', () => {
  const r = SP.apply({}, '', {});
  for (const k of SP.PROXY_KEYS) assert.strictEqual(r.settings.env[k], '');
  const own = SP.apply({ env: { HTTPS_PROXY: 'http://corp:3128' } }, '', {});
  assert.strictEqual(own.settings.env.HTTPS_PROXY, 'http://corp:3128');
  assert.ok(!('HTTPS_PROXY' in own.owned));
  const back = SP.apply(own.settings, null, own.owned);
  assert.deepStrictEqual(back.settings, { env: { HTTPS_PROXY: 'http://corp:3128' } });
});

test('proxy → direct → proxy round-trips without losing the original', () => {
  const a = SP.apply({ env: { NO_PROXY: 'x' } }, PX, {});
  const b = SP.apply(a.settings, '', a.owned);
  assert.strictEqual(b.settings.env.HTTPS_PROXY, '');
  assert.strictEqual(b.settings.env.NO_PROXY, 'x', 'direct does not need our NO_PROXY');
  const c = SP.apply(b.settings, null, b.owned);
  assert.deepStrictEqual(c.settings, { env: { NO_PROXY: 'x' } });
});

test('a second identical write changes nothing', () => {
  const a = SP.apply({}, PX, {});
  const b = SP.apply(a.settings, PX, a.owned);
  assert.strictEqual(b.changed, false);
  assert.deepStrictEqual(b.owned, a.owned);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; } catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1; }
  }
  console.log(`sub-proxy: ${passed}/${tests.length} passed`);
})();
