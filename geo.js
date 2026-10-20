'use strict';
// geo.js — регион, из которого работает сворм. Из-под российского адреса агенты не работают:
// вкладка, чей выход в сеть российский, замораживается (SIGSTOP), печать в неё закрыта, а когда
// адрес сменится, агент продолжает с того же места. Окно сворма при этом открыто. Здесь только
// решения — разбор ответов сервисов и переходы состояния; сеть, сигналы и окно живут в main.js.
//
// Страну спрашиваем у самих Anthropic, по очереди (первый не ответил — второй): оба адреса стоят
// за Cloudflare, и его /cdn-cgi/trace отдаёт страну того адреса, с которого мы пришли. Важно, что
// именно у них: VPN на роутере часто гонит через себя только выбранные сайты, и нейтральный
// сервис (cloudflare.com, ipinfo.io) увидел бы прямой российский выход, хотя сам Claude идёт через
// VPN. Нас интересует ровно тот путь, которым ходит агент.
//
// Ни один не ответил — состояние НЕ меняется: на старте это «можно» (без сети сворм иначе не
// запустился бы вовсе), посреди работы — то, что было. Отвалившийся VPN, который заодно уронил
// связь с обоими сервисами, не должен ни разморозить вкладки, ни заморозить их наугад.

const BLOCKED = new Set(['RU']);

const SOURCES = [
  { url: 'https://api.anthropic.com/cdn-cgi/trace', parse: parseTrace },
  { url: 'https://claude.ai/cdn-cgi/trace', parse: parseTrace },
];

// Общая проверка — страховка на случай, когда адрес сменился без смены подключений (VPN
// переключил сервер выхода). Главный повод — смена подключений: их смотрим локально, без сети,
// и при любой перемене спрашиваем страну сразу (см. netSignature).
const CHECK_EVERY_MS = 15_000;
const NET_POLL_MS = 2_000;
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

// Отпечаток сетевых подключений (os.networkInterfaces()): включённый или отвалившийся VPN
// добавляет, убирает или меняет адрес у виртуального подключения (utun…), смена Wi‑Fi — у en0.
// Внутренние (lo0) не в счёт. Порядок подключений и адресов не важен.
function netSignature(ifaces) {
  const rows = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    const addrs = (Array.isArray(list) ? list : []).filter((a) => a && !a.internal).map((a) => a.address).sort();
    if (addrs.length) rows.push(`${name}=${addrs.join(',')}`);
  }
  return rows.sort().join(' ');
}

// Флажок страны: двухбуквенный код → эмодзи из двух «региональных букв».
function flagOf(country) {
  const c = String(country || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '';
  return String.fromCodePoint(...[...c].map((ch) => 0x1F1E6 + ch.charCodeAt(0) - 65));
}

// Новое состояние «закрыт ли сворм» по ответу. country пустой — ответа не было: остаёмся, где были.
function nextBlocked(prev, country) {
  if (!country) return !!prev;
  return BLOCKED.has(String(country).toUpperCase());
}

// --- прокси подписок ------------------------------------------------------------
// У подписки бывает свой прокси (Настройки → Подписки), и тогда её вкладки выходят в сеть не
// оттуда, где стоит мак. Страну такой подписки спрашиваем через её прокси, а решение «заморозить»
// принимаем по вкладке, а не по всему сворму: во Франции с прокси подписки в России замёрзнуть
// должна именно она, а в России с прокси за границей — работать.
//
// Состояние прокси — { country, tried }: country — последний ответ (пусто — ни разу не ответил),
// tried — проверка через него уже была. Как и у прямого выхода, молчание ответ не меняет.

// Заморожена ли вкладка. Без прокси — как сам мак. Прокси ни разу не ответил — тоже как мак:
// мёртвый прокси вкладку и так в сеть не пустит, а гадать о его стране не по чему.
function tabBlocked(directBlocked, proxyState) {
  const c = proxyState && proxyState.country;
  if (!c) return !!directBlocked;
  return BLOCKED.has(String(c).toUpperCase());
}

// Можно ли уже решать про вкладку: прямой выход проверен, а если у неё прокси — проверен и он.
// Пока нельзя, агента во вкладке не запускаем (см. geoGate в main.js).
//
// Окно сворма регион не закрывает: из любой страны можно открыть приложение, переключать вкладки,
// менять настройки. Замерзает только вкладка, чей выход в запрещённой стране.
function tabKnown(directKnown, proxy, proxyState) {
  if (!directKnown) return false;
  return !proxy || !!(proxyState && proxyState.tried);
}

module.exports = { BLOCKED, SOURCES, CHECK_EVERY_MS, NET_POLL_MS, FETCH_TIMEOUT_MS, parseTrace, parsePlain, nextBlocked, netSignature, flagOf, tabBlocked, tabKnown };
