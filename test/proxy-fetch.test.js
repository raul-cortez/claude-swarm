// Run: node test/proxy-fetch.test.js
// Настоящий туннель на локальных портах: прокси, понимающий CONNECT, и сервис за ним. Сервис
// обычный HTTP — TLS поверх туннеля у нас общий с https и тут не проверяется.
const assert = require('assert');
const http = require('http');
const net = require('net');
const { fetchViaProxy } = require('../proxy-fetch');

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const open = new Set();
function listen(server) {
  server.on('connection', (c) => { open.add(c); c.on('close', () => open.delete(c)); });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

async function stand(needAuth) {
  const target = http.createServer((req, res) => res.end('loc=FR\n'));
  const targetPort = await listen(target);
  const seen = [];
  const proxy = http.createServer();
  proxy.on('connect', (req, client) => {
    seen.push({ path: req.url, auth: req.headers['proxy-authorization'] || '' });
    if (needAuth && req.headers['proxy-authorization'] !== needAuth) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    const [host, port] = req.url.split(':');
    const up = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.pipe(client); client.pipe(up);
    });
    up.on('error', () => client.destroy());
  });
  const proxyPort = await listen(proxy);
  return { targetPort, proxyPort, seen, close: () => { target.close(); proxy.close(); } };
}

test('ходит туннелем через прокси и отдаёт ответ сервиса', async () => {
  const s = await stand('');
  try {
    const r = await fetchViaProxy(`http://127.0.0.1:${s.proxyPort}`, `http://127.0.0.1:${s.targetPort}/cdn-cgi/trace`, 3000);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.text, 'loc=FR\n');
    assert.strictEqual(s.seen[0].path, `127.0.0.1:${s.targetPort}`);
  } finally { s.close(); }
});

test('логин и пароль из адреса уходят Basic-авторизацией, раскодированными', async () => {
  const want = 'Basic ' + Buffer.from('e.n:p@ss:w').toString('base64');
  const s = await stand(want);
  try {
    const r = await fetchViaProxy(`http://e.n:p%40ss%3Aw@127.0.0.1:${s.proxyPort}`, `http://127.0.0.1:${s.targetPort}/`, 3000);
    assert.strictEqual(r.text, 'loc=FR\n');
  } finally { s.close(); }
});

test('прокси отказал — ошибка, а не пустой ответ', async () => {
  const s = await stand('Basic xxx');
  try {
    await assert.rejects(fetchViaProxy(`http://127.0.0.1:${s.proxyPort}`, `http://127.0.0.1:${s.targetPort}/`, 3000), /407/);
  } finally { s.close(); }
});

test('прокси не отвечает — ошибка по таймауту, без зависания', async () => {
  const silent = net.createServer(() => {});
  const port = await listen(silent);
  try {
    await assert.rejects(fetchViaProxy(`http://127.0.0.1:${port}`, 'http://example.com/', 300), /timeout/);
  } finally { silent.close(); }
});

(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ok —', name); }
    catch (e) { console.error('FAIL —', name); console.error(e); process.exitCode = 1; }
  }
  for (const c of open) c.destroy();
  console.log(`\n${passed}/${tests.length} proxy-fetch tests passed`);
})();
