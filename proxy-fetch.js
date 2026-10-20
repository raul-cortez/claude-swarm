'use strict';
// GET через HTTP(S)-прокси — для проверки страны подписки, у которой свой прокси (см. geo.js).
//
// Сворм сам в сеть через прокси не ходит: прокси подписки ставится только в окружение её
// вкладок (launch-line.proxyEnv). А страну этой подписки надо спросить именно оттуда, откуда
// выходит её Клод, — поэтому один запрос туннелем: CONNECT к прокси, дальше TLS до сервиса.
// Встроенный fetch прокси не умеет, а тянуть ради одного запроса зависимость незачем.
//
// Логин и пароль прокси — из адреса, обычной Basic-авторизацией, как их передаёт и сам Клод.

const http = require('http');
const https = require('https');
const tls = require('tls');

function fetchViaProxy(proxyUrl, targetUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let p; let t;
    try { p = new URL(proxyUrl); t = new URL(targetUrl); } catch (e) { reject(e); return; }
    const secureTarget = t.protocol === 'https:';
    const targetPort = Number(t.port) || (secureTarget ? 443 : 80);
    const authority = `${t.hostname}:${targetPort}`;
    const headers = { Host: authority };
    if (p.username) {
      const dec = (v) => { try { return decodeURIComponent(v); } catch (_) { return v; } };
      headers['Proxy-Authorization'] = 'Basic '
        + Buffer.from(`${dec(p.username)}:${dec(p.password)}`).toString('base64');
    }
    const secureProxy = p.protocol === 'https:';
    let done = false;
    let sock = null;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Туннель одноразовый: закрываем и после ответа, иначе он держит соединение с прокси.
      try { if (sock) sock.destroy(); } catch (_) {}
      try { req.destroy(); } catch (_) {}
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs || 5000);
    const req = (secureProxy ? https : http).request({
      host: p.hostname,
      port: Number(p.port) || (secureProxy ? 443 : 80),
      method: 'CONNECT',
      path: authority,
      headers,
    });
    req.on('connect', (res, socket) => {
      sock = socket;
      if (res.statusCode !== 200) { finish(new Error(`proxy ${res.statusCode}`)); return; }
      const opts = {
        host: t.hostname,
        port: targetPort,
        path: t.pathname + t.search,
        headers: { Host: t.host, Connection: 'close' },
        // Без agent: с agent:false Node заводит свой агент и createConnection не зовёт — запрос
        // уходит мимо туннеля, напрямую с мака, и прокси «оказывается» в стране мака.
        createConnection: () => (secureTarget ? tls.connect({ socket, servername: t.hostname }) : socket),
      };
      const get = (secureTarget ? https : http).get(opts, (r) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (ch) => { body += ch; if (body.length > 64 * 1024) finish(new Error('too long')); });
        r.on('end', () => finish(null, { status: r.statusCode, text: body }));
        r.on('error', finish);
      });
      get.on('error', finish);
    });
    req.on('error', finish);
    req.end();
  });
}

module.exports = { fetchViaProxy };
