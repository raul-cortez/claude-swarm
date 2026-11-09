'use strict';
// proxy-relay.js — a tiny local hop between a subscription's Claude and its HTTP proxy.
//
// Why: a Claude tab opens a tunnel with a plain-text request
//     CONNECT api.anthropic.com:443
//     Host: api.anthropic.com:443
// Router- or desktop-side VPN clients built on sing-box / Xray / Clash (Podkop on OpenWrt,
// Happ, v2rayN …) "sniff" that Host header and, with destination override on, send the
// connection straight to api.anthropic.com instead of to the proxy. Anthropic gets a CONNECT it
// can't answer and stays silent; the tab waits for a timeout, retries, and starts for minutes.
// Seen live 2026-11-08 after a VPN config change on the router: CONNECT hung 15 s+, the same
// request with `Host: <proxy>` went through in 0.9 s. Claude has no knob for that header.
//
// So Swarm listens on 127.0.0.1 and hands tabs that address as their proxy. Each request head
// gets two edits and goes on to the real proxy, untouched otherwise:
//  - Host names the proxy itself (CONNECT only: the target stays in the request line, which is
//    what a proxy actually reads — RFC 9110 §9.3.6). A sniffer sees "traffic for the proxy" and
//    leaves the destination alone.
//  - Proxy-Authorization comes from the real proxy URL, so the login and password never have to
//    sit in a tab's environment or in the subscription's settings.json.
// The bytes after the head (TLS to Anthropic) pass through as they are: Swarm can't read them.
//
// For a proxy nobody sniffs (no VPN, VPN in plain tunnel mode) the edits change nothing: a proxy
// ignores Host on CONNECT. Only http:// proxies get a relay — an https:// proxy hides the CONNECT
// inside TLS, there is nothing to sniff. (Relaying one would also mean Swarm's own TLS to the
// proxy, with Node's CA list instead of the one Claude trusts — a corporate CA would break.)
//
// Two relays per proxy:
//  - the main one (split off) sends everything to the proxy. Claude itself talks to it: whatever
//    host Claude calls, it never leaves the proxy.
//  - the split one is for the commands Claude runs — git, gh, npm, curl. The Swarm hook points
//    their proxy variables here (hooks/swarm-signal.mjs, proxyEnvLine). Anthropic's hosts still go
//    to the proxy (a nested `claude -p`, curl to the API); everything else goes straight from the
//    Mac. If the direct way fails (a corporate firewall that only lets the proxy out, a name only
//    the proxy can resolve), the connection quietly goes through the proxy after all, and that
//    host goes through the proxy for a while without trying again.
// If the hook never runs, commands keep the main relay: slower, never Claude off the proxy.

const net = require('net');

const MAX_HEAD = 64 * 1024;
const DIRECT_TIMEOUT_MS = 4000;          // a firewall that drops instead of refusing
const DIRECT_BLOCKED_MS = 10 * 60 * 1000; // how long a host that failed direct skips the attempt

// Anthropic's hosts: in split mode they still ride the proxy. A domain matches itself and every
// subdomain. A host missing here only means a command reaches it directly — Claude itself is on
// the main relay and never depends on this list.
const CLAUDE_DOMAINS = ['anthropic.com', 'claude.ai', 'claude.com'];

function isClaudeHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return CLAUDE_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

// "host:port" / "[v6]:port" -> { host, port }. null — not an authority.
function splitAuthority(target) {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(target) || /^([^:\s]+):(\d+)$/.exec(target);
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1], port } : null;
}

// Which way a request goes first: 'proxy' or 'direct'. Pure, for tests. blocked — host -> time
// until which direct is not tried.
function routeOf(target, split, blocked, now) {
  if (!split) return 'proxy';
  const a = splitAuthority(target);
  if (!a || isClaudeHost(a.host)) return 'proxy';
  const key = a.host.toLowerCase();
  const until = blocked && blocked.get(key);
  if (until && until > (now || Date.now())) return 'proxy';
  if (until) blocked.delete(key);   // expired: forget it, the map stays as small as the trouble
  return 'direct';
}

function decode(v) { try { return decodeURIComponent(v); } catch (_) { return v; } }

// Real proxy URL -> what the relay needs to know about it. null — not a proxy we relay.
function upstreamOf(proxyUrl) {
  let u;
  try { u = new URL(String(proxyUrl || '')); } catch (_) { return null; }
  if (u.protocol !== 'http:' || !u.hostname) return null;
  const port = Number(u.port) || 80;
  const host = u.hostname;   // IPv6 stays bracketed in URL.hostname
  return {
    host: host.replace(/^\[|\]$/g, ''),
    port,
    authority: `${host}:${port}`,
    auth: u.username ? 'Basic ' + Buffer.from(`${decode(u.username)}:${decode(u.password)}`).toString('base64') : '',
  };
}

function withoutHeaders(lines, names) {
  return lines.filter((l) => {
    const i = l.indexOf(':');
    return !(i > 0 && names.includes(l.slice(0, i).trim().toLowerCase()));
  });
}

function connectHead(target, up) {
  return [`CONNECT ${target} HTTP/1.1`, `Host: ${up.authority}`]
    .concat(up.auth ? [`Proxy-Authorization: ${up.auth}`] : []).join('\r\n');
}

// Turn one request head from the tab (text up to, without, the blank line) into what goes to
// the real proxy. Pure, for tests. Returns
//   { connect: head }                  — a tunnel request, forwarded as is after the edits;
//   { connect: head, then: request }   — plain HTTP: its Host would be sniffed the same way, so it
//                                        rides a tunnel too, and `then` goes inside it;
//   null                               — not something a proxy client sends.
function planRequest(head) {
  const lines = String(head).split('\r\n');
  const first = lines.shift() || '';
  const m = /^(\S+)\s+(\S+)\s+(HTTP\/\d(?:\.\d)?)$/.exec(first);
  if (!m) return null;
  const [, method, target, version] = m;
  if (method.toUpperCase() === 'CONNECT') return { target };
  let u;
  try { u = new URL(target); } catch (_) { return null; }
  if (u.protocol !== 'http:') return null;
  const authority = `${u.hostname}:${Number(u.port) || 80}`;
  const kept = withoutHeaders(lines, ['proxy-authorization', 'proxy-connection', 'connection']);
  // One request per tunnel: a kept-alive connection would carry the next request to whatever
  // host the first one named.
  const request = [`${method} ${u.pathname + u.search} ${version}`, ...kept, 'Connection: close'].join('\r\n');
  return { target: authority, request };
}

function handle(client, up, opts) {
  const split = !!(opts && opts.split);
  const blocked = (opts && opts.blocked) || new Map();
  client.setNoDelay(true);
  let buf = Buffer.alloc(0);
  let upstream = null;
  client.on('error', () => { client.destroy(); if (upstream) upstream.destroy(); });
  client.on('close', () => { if (upstream) upstream.destroy(); });
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf('\r\n\r\n');
    if (end === -1) {
      if (buf.length > MAX_HEAD) client.end('HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n');
      return;
    }
    client.removeListener('data', onData);
    client.pause();
    const head = buf.slice(0, end).toString('latin1');
    const rest = buf.slice(end + 4);
    const route = planRequest(head);
    if (!route) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const plan = { connect: connectHead(route.target, up), then: route.request };
    let answered = false;
    const splice = () => { upstream.pipe(client); client.pipe(upstream); client.resume(); };
    // Before an answer the tab hears an honest 502. After it, a broken far side cuts the tab off,
    // a closed one ends it gently — destroy() could drop the last bytes still in the buffer.
    const watch = () => {
      upstream.on('error', () => {
        if (!answered && client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        else client.destroy();
      });
      upstream.on('close', () => {
        if (!answered && client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        else client.end();
      });
    };

    const viaProxy = () => {
      if (client.destroyed) return;
      upstream = net.connect(up.port, up.host, () => {
        upstream.setNoDelay(true);
        if (plan.then == null) {
          // A tunnel: the proxy's answer and everything after it are the tab's business.
          upstream.write(Buffer.concat([Buffer.from(plan.connect + '\r\n\r\n', 'latin1'), rest]));
          upstream.once('data', () => { answered = true; });
          splice();
          return;
        }
        // Plain HTTP inside a tunnel: wait for the proxy's 200, swallow it, then send the request.
        upstream.write(plan.connect + '\r\n\r\n', 'latin1');
        let got = Buffer.alloc(0);
        const onReply = (c) => {
          got = Buffer.concat([got, c]);
          const e = got.indexOf('\r\n\r\n');
          if (e === -1) { if (got.length > MAX_HEAD) upstream.destroy(); return; }
          upstream.removeListener('data', onReply);
          answered = true;
          if (!/^HTTP\/\d(?:\.\d)?\s+200\b/.test(got.slice(0, e).toString('latin1'))) {
            client.end(got);   // 407, 403, 502 … — the proxy's own answer is the most honest one
            upstream.destroy();
            return;
          }
          const after = got.slice(e + 4);
          if (after.length) client.write(after);
          upstream.write(Buffer.concat([Buffer.from(plan.then + '\r\n\r\n', 'latin1'), rest]));
          splice();
        };
        upstream.on('data', onReply);
      });
      watch();
    };

    // Straight from the Mac. Nothing has been said to the tab until the socket is up, so a failure
    // here can still turn into the proxy way without the tab noticing anything but a delay.
    const viaDirect = () => {
      const a = splitAuthority(route.target);
      let settled = false;
      const s = net.connect(a.port, a.host);
      upstream = s;
      const giveUp = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        s.removeAllListeners('error');
        s.on('error', () => {});
        s.destroy();
        // The tab hung up while we were trying: nothing failed, nothing to remember.
        if (client.destroyed) return;
        blocked.set(a.host.toLowerCase(), Date.now() + DIRECT_BLOCKED_MS);
        viaProxy();
      };
      const timer = setTimeout(giveUp, DIRECT_TIMEOUT_MS);
      client.once('close', () => { if (!settled) giveUp(); });
      s.once('error', giveUp);
      s.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        s.removeListener('error', giveUp);
        s.setNoDelay(true);
        answered = true;
        if (route.request == null) client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        else s.write(route.request + '\r\n\r\n', 'latin1');
        if (rest.length) s.write(rest);
        // A firewall or DPI box that lets TCP open and then resets it can't be undone here: the
        // tab already has its tunnel. But the host is remembered, so the retry goes via the proxy.
        // A tunnel that ends without a single byte back from the target, after the tab had sent
        // something, is what a firewall or DPI box looks like: reset, EPIPE or a silent drop the tab
        // gave up on. It can't be undone here — the tab already has its tunnel — but the host is
        // remembered, so the retry goes through the proxy.
        let heard = false;
        let spoke = rest.length > 0 || route.request != null;
        s.once('data', () => { heard = true; });
        client.on('data', () => { spoke = true; });
        s.once('close', () => {
          if (!heard && spoke) blocked.set(a.host.toLowerCase(), Date.now() + DIRECT_BLOCKED_MS);
        });
        watch();
        splice();
      });
    };

    if (routeOf(route.target, split, blocked) === 'direct') viaDirect(); else viaProxy();
  };
  client.on('data', onData);
}

// Listen on 127.0.0.1:port (0 — any free port; a taken port falls back to any). Resolves with
// { url, port, close }; rejects if the proxy URL isn't one we relay. opts.split — the relay for
// commands (see the top of the file).
function startRelay(proxyUrl, port, opts) {
  const split = !!(opts && opts.split);
  const blocked = new Map();
  const up = upstreamOf(proxyUrl);
  if (!up) return Promise.reject(new Error('not an http proxy'));
  const open = new Set();
  const server = net.createServer((c) => {
    open.add(c);
    c.on('close', () => open.delete(c));
    handle(c, up, { split, blocked });
  });
  const listen = (p) => new Promise((resolve, reject) => {
    const onErr = (e) => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onErr); resolve(); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(p, '127.0.0.1');
  });
  return listen(Number(port) || 0)
    .catch((e) => { if (port && e.code === 'EADDRINUSE') return listen(0); throw e; })
    .then(() => {
      const p = server.address().port;
      server.on('error', () => {});
      return {
        port: p,
        url: `http://127.0.0.1:${p}`,
        close() { server.close(); for (const c of open) c.destroy(); },
      };
    });
}

// The same proxy gets the same port from one launch to the next, so a Claude started by hand
// from settings.json between two Swarm runs still finds the relay. 20000–39999: above the
// usual dev-server ports, below the ephemeral range macOS and Linux hand out.
function stablePort(proxyUrl) {
  let h = 2166136261;
  for (const ch of String(proxyUrl || '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return 20000 + (h % 20000);
}

module.exports = { upstreamOf, planRequest, connectHead, routeOf, isClaudeHost, splitAuthority, startRelay, stablePort, CLAUDE_DOMAINS };
