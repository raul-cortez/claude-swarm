'use strict';
// geo.js — регион, из которого работает сворм. Из-под российского адреса сворм не работает:
// окно закрывается заглушкой, агенты замораживаются (SIGSTOP) и продолжают с того же места, как
// только адрес сменится. Здесь только решения — разбор ответов сервисов и переходы состояния;
// сеть, сигналы и окно живут в main.js.
//
// Страну спрашиваем у двух сервисов по очереди (первый не ответил — второй). Оба отдают страну
// того адреса, с которого мы к ним пришли, без ключей и регистрации.
//
// Ни один не ответил — состояние НЕ меняется: на старте это «можно» (без сети сворм иначе не
// запустился бы вовсе), посреди работы — то, что было. Отвалившийся VPN, который заодно уронил
// связь с обоими сервисами, не должен ни разморозить вкладки, ни заморозить их наугад.

const BLOCKED = new Set(['RU']);

const SOURCES = [
  { url: 'https://www.cloudflare.com/cdn-cgi/trace', parse: parseTrace },
  { url: 'https://ipinfo.io/country', parse: parsePlain },
];

const CHECK_EVERY_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

// Cloudflare: строки «key=value», страна — в loc.
function parseTrace(text) {
  const m = String(text || '').match(/^loc=([A-Za-z]{2})\s*$/m);
  return m ? m[1].toUpperCase() : '';
}

// ipinfo: одна строка, двухбуквенный код.
function parsePlain(text) {
  const t = String(text || '').trim();
  return /^[A-Za-z]{2}$/.test(t) ? t.toUpperCase() : '';
}

// Новое состояние «закрыт ли сворм» по ответу. country пустой — ответа не было: остаёмся, где были.
function nextBlocked(prev, country) {
  if (!country) return !!prev;
  return BLOCKED.has(String(country).toUpperCase());
}

module.exports = { BLOCKED, SOURCES, CHECK_EVERY_MS, FETCH_TIMEOUT_MS, parseTrace, parsePlain, nextBlocked };
