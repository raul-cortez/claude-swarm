// Run: node test/proxy-relay.test.js
// The relay against a real local "proxy" that records what reaches it, and a plain HTTP service
// behind it. curl-free: the client side speaks raw sockets, the way Claude's HTTP stack does.
const assert = require('assert');
const http = require('http');
const net = require('net');
const relay = require('../proxy-relay');

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const AUTH = 'Basic ' + Buffer.from('e.n:p@ss:w').toString('base64');

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

async function stand() {
  const target = http.createServer((req, res) => res.end(`path=${req.url} host=${req.headers.host}`));
  const targetPort = await listen(target);
  const seen = [];
  const proxy = http.createServer((req, res) => { seen.push({ plain: req.url }); res.end('plain'); });
  proxy.on('connect', (req, client, early) => {
    seen.push({ path: req.url, host: req.headers.host, auth: req.headers['proxy-authorization'] || '' });
    if (req.headers['proxy-authorization'] !== AUTH) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    // Every name leads to the local service: a request that skipped the tunnel would hit
    // relay.invalid for real and fail.
    const up = net.connect(targetPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (early && early.length) up.write(early);   // bytes the client sent right behind CONNECT
      up.pipe(client); client.pipe(up);
    });
    up.on('error', () => client.destroy());
  });
  const open = new Set();
  proxy.on('connection', (c) => { open.add(c); c.on('close', () => open.delete(c)); });
  const proxyPort = await listen(proxy);
  return {
    targetPort, proxyPort, seen,
    close: () => { target.close(); for (const c of open) c.destroy(); proxy.close(); },
  };
}

function talk(port, text) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    let got = '';
    s.setEncoding('latin1');
    s.on('data', (c) => { got += c; });
    s.on('end', () => resolve(got));
    s.on('error', reject);
    setTimeout(() => { s.destroy(); resolve(got); }, 1500);
  });
}

test('planRequest: CONNECT keeps the target, plain HTTP becomes a tunnel + origin-form request', () => {
  assert.deepStrictEqual(relay.planRequest('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443'),
    { target: 'api.anthropic.com:443' });
  const p = relay.planRequest('GET http://example.com/a?b=1 HTTP/1.1\r\nHost: example.com\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: Basic x\r\nAccept: */*');
  assert.strictEqual(p.target, 'example.com:80');
  assert.strictEqual(p.request, 'GET /a?b=1 HTTP/1.1\r\nHost: example.com\r\nAccept: */*\r\nConnection: close');
  assert.strictEqual(relay.planRequest('garbage'), null);
  assert.strictEqual(relay.planRequest('GET /local HTTP/1.1\r\nHost: x'), null);
});

test('rewriteHead: Host names the proxy, auth comes from the real URL, the tab\'s auth is dropped', () => {
  const up = relay.upstreamOf('http://e.n:p%40ss%3Aw@51.146.72.104:47897');
  const r = relay.rewriteHead('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nProxy-Authorization: Basic bad', up);
  assert.strictEqual(r.connect,
    `CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: 51.146.72.104:47897\r\nProxy-Authorization: ${AUTH}`);
  assert.strictEqual(r.then, undefined);
});

test('upstreamOf: http:// and https:// proxies are relayed, nothing else', () => {
  assert.strictEqual(relay.upstreamOf('https://h:1').secure, true);
  assert.strictEqual(relay.upstreamOf('https://h').authority, 'h:443');
  assert.strictEqual(relay.upstreamOf('http://h:1').secure, false);
  assert.strictEqual(relay.upstreamOf('socks5://h:1'), null);
  assert.strictEqual(relay.upstreamOf('nonsense'), null);
  assert.strictEqual(relay.upstreamOf('http://h').authority, 'h:80');
  assert.strictEqual(relay.upstreamOf('http://h:8').auth, '');
});

test('stablePort: same proxy, same port, inside 20000–39999', () => {
  const a = relay.stablePort('http://u:p@h:1');
  assert.strictEqual(a, relay.stablePort('http://u:p@h:1'));
  assert.ok(a >= 20000 && a < 40000);
});

test('CONNECT through the relay: proxy sees its own Host and the real credentials', async () => {
  const s = await stand();
  const r = await relay.startRelay(`http://e.n:p%40ss%3Aw@127.0.0.1:${s.proxyPort}`, 0);
  try {
    const got = await talk(r.port,
      `CONNECT relay.invalid:${s.targetPort} HTTP/1.1\r\nHost: relay.invalid:${s.targetPort}\r\n\r\n`
      + `GET /x HTTP/1.1\r\nHost: relay.invalid\r\nConnection: close\r\n\r\n`);
    assert.match(got, /^HTTP\/1\.1 200 Connection Established/);
    assert.match(got, /path=\/x host=relay\.invalid/);
    assert.deepStrictEqual(s.seen[0], { path: `relay.invalid:${s.targetPort}`, host: `127.0.0.1:${s.proxyPort}`, auth: AUTH });
  } finally { r.close(); s.close(); }
});

test('plain HTTP rides a tunnel too: the proxy never sees a sniffable Host', async () => {
  const s = await stand();
  const r = await relay.startRelay(`http://e.n:p%40ss%3Aw@127.0.0.1:${s.proxyPort}`, 0);
  try {
    const got = await talk(r.port, `GET http://relay.invalid:${s.targetPort}/page?q=1 HTTP/1.1\r\nHost: relay.invalid:${s.targetPort}\r\nProxy-Connection: keep-alive\r\n\r\n`);
    assert.match(got, /^HTTP\/1\.1 200 OK/);
    assert.ok(!/Connection Established/.test(got), 'the tunnel reply is ours, not the tab\'s');
    assert.match(got, new RegExp(`path=/page\\?q=1 host=relay\\.invalid:${s.targetPort}`));
    assert.strictEqual(s.seen[0].host, `127.0.0.1:${s.proxyPort}`);
    assert.ok(!s.seen.some((x) => x.plain), 'nothing went to the proxy as a plain request');
  } finally { r.close(); s.close(); }
});

test('wrong credentials: the proxy\'s own 407 reaches the tab', async () => {
  const s = await stand();
  const r = await relay.startRelay(`http://x:y@127.0.0.1:${s.proxyPort}`, 0);
  try {
    assert.match(await talk(r.port, 'GET http://relay.invalid/ HTTP/1.1\r\nHost: relay.invalid\r\n\r\n'), /^HTTP\/1\.1 407/);
    assert.match(await talk(r.port, 'CONNECT relay.invalid:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 407/);
  } finally { r.close(); s.close(); }
});

test('proxy unreachable: the tab gets 502, not silence', async () => {
  const dead = net.createServer();
  const port = await listen(dead);
  dead.close();
  const r = await relay.startRelay(`http://127.0.0.1:${port}`, 0);
  try {
    assert.match(await talk(r.port, 'CONNECT relay.invalid:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 502/);
  } finally { r.close(); }
});

test('a taken port falls back to any free one', async () => {
  const busy = net.createServer();
  const port = await listen(busy);
  const r = await relay.startRelay('http://127.0.0.1:9', port);
  try { assert.notStrictEqual(r.port, port); } finally { r.close(); busy.close(); }
});

(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + e.stack); process.exitCode = 1; }
  }
  console.log(`proxy-relay: ${passed}/${tests.length}`);
})();
