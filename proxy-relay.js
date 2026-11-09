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
// ignores Host on CONNECT. An https:// proxy hides the CONNECT inside TLS, so there is nothing
// to sniff, but it gets a relay too: the same address scheme for every subscription, and the
// login stays out of the tab's environment.
//
// Everything that reaches the relay goes to the proxy. Which traffic reaches it is decided
// elsewhere: commands Claude runs (git, npm, curl) have the proxy variables removed by the Swarm
// hook (SWARM_PROXY_DIRECT in hooks/swarm-signal.mjs), so only Claude itself comes here.

const net = require('net');
const tls = require('tls');

const MAX_HEAD = 64 * 1024;

function decode(v) { try { return decodeURIComponent(v); } catch (_) { return v; } }

// Real proxy URL -> what the relay needs to know about it. null — not a proxy we relay.
function upstreamOf(proxyUrl) {
  let u;
  try { u = new URL(String(proxyUrl || '')); } catch (_) { return null; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname) return null;
  const secure = u.protocol === 'https:';
  const port = Number(u.port) || (secure ? 443 : 80);
  const host = u.hostname;   // IPv6 stays bracketed in URL.hostname
  return {
    host: host.replace(/^\[|\]$/g, ''),
    port,
    secure,
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

function rewriteHead(head, up) {
  const plan = planRequest(head);
  if (!plan) return null;
  return plan.request == null
    ? { connect: connectHead(plan.target, up) }
    : { connect: connectHead(plan.target, up), then: plan.request };
}

function connectUpstream(up, onReady) {
  if (!up.secure) return net.connect(up.port, up.host, onReady);
  const opts = { host: up.host, port: up.port };
  if (!net.isIP(up.host)) opts.servername = up.host;
  return tls.connect(opts, onReady);
}

function handle(client, up) {
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
    const plan = rewriteHead(buf.slice(0, end).toString('latin1'), up);
    const rest = buf.slice(end + 4);
    if (!plan) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    let answered = false;
    const splice = () => { upstream.pipe(client); client.pipe(upstream); client.resume(); };
    upstream = connectUpstream(up, () => {
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
    upstream.on('error', () => {
      if (!answered && client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      else client.destroy();
    });
    upstream.on('close', () => { if (!answered && client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); else client.destroy(); });
  };
  client.on('data', onData);
}

// Listen on 127.0.0.1:port (0 — any free port; a taken port falls back to any). Resolves with
// { url, port, close }; rejects if the proxy URL isn't one we relay.
function startRelay(proxyUrl, port) {
  const up = upstreamOf(proxyUrl);
  if (!up) return Promise.reject(new Error('not an http proxy'));
  const open = new Set();
  const server = net.createServer((c) => {
    open.add(c);
    c.on('close', () => open.delete(c));
    handle(c, up);
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

module.exports = { upstreamOf, planRequest, rewriteHead, startRelay, stablePort };
