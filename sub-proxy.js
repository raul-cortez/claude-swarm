'use strict';
// sub-proxy.js — прокси подписки в настройках САМОЙ подписки: <папка конфига>/settings.json,
// блок env. Клод берёт оттуда переменные при любом запуске, как бы его ни запустили.
//
// Зачем, если прокси и так кладётся в окружение вкладки (launch-line.proxyEnv): окружение
// вкладки задаётся один раз, при её открытии, по команде, которой её открыли. Запусти в ней
// потом руками другую подписку — стрелкой вверх (история у оболочек общая и подставляет строку
// соседней вкладки), из обычного терминала — и та уйдёт в сеть с чужим выходом: «личная» в
// оболочке рабочей вкладки — напрямую с мака, рабочая в оболочке «личной» — через её прокси.
// Так и было 2026-10-22: прораба перезапустили стрелкой вверх, и он полдня ходил без прокси.
//
// Правило: если хоть у одной подписки прокси есть, у каждой подписки с известной папкой выход
// записан явно. С прокси — его адрес, без прокси — пустое значение: пустое Клод читает как
// «без прокси» и не берёт то, что досталось от оболочки (проверено живьём). Ни у кого прокси
// нет — ничего не пишем и только убираем своё.
//
// Пишем только то, что понимаем как своё, и помним это (owned): что записали и что стояло до
// нас. Снимаем — возвращаем как было. Значение, которое человек сам поменял после нас, не
// трогаем. Здесь только решения; чтение и запись файлов — в main.js.

const PROXY_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'];
const NO_PROXY_KEYS = ['NO_PROXY', 'no_proxy'];
const LOCAL_NO_PROXY = ['localhost', '127.0.0.1', '::1'];

function stemOf(text) {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/)[0].replace(/^.*[/\\]/, '') : '';
}

// Чего хотим для каждой папки конфига: адрес прокси, '' — явно напрямую. Папки, которых в
// ответе нет, — «не наше дело» (своё в них снимается).
// cards — [{ line, home }], proxies — [{ line, proxy }] (только включённые), normalize —
// launch-line.normalizeProxy: неразборчивый адрес — то же, что его нет.
function wanted(cards, proxies, normalize) {
  const norm = typeof normalize === 'function' ? normalize : (x) => String(x || '').trim();
  const byStem = new Map();
  for (const p of Array.isArray(proxies) ? proxies : []) {
    const url = norm(p && p.proxy);
    const stem = stemOf(p && p.line);
    if (url && stem && !byStem.has(stem)) byStem.set(stem, url);
  }
  const out = new Map();
  if (!byStem.size) return out;
  for (const c of Array.isArray(cards) ? cards : []) {
    const home = String((c && c.home) || '').trim();
    if (!home) continue;   // папку ещё не узнали — вкладкам хватает окружения от сворма
    const url = byStem.get(stemOf(c.line)) || '';
    // У одной папки бывает несколько карточек (`claude` и `claude --model opus`): прокси
    // любой из них — прокси папки.
    if (!out.get(home)) out.set(home, url);
  }
  return out;
}

function mergeNoProxy(have) {
  const list = String(have || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.concat(LOCAL_NO_PROXY.filter((h) => !list.includes(h))).join(',');
}

// Новые настройки папки. want: адрес | '' (напрямую) | null (снять своё).
// owned — { KEY: { set, prev } }: что мы записали и что стояло до нас (prev === undefined —
// ключа не было). Возвращает { settings, owned, changed }; исходные объекты не меняет.
function apply(settings, want, owned) {
  const s = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  const env0 = s.env && typeof s.env === 'object' && !Array.isArray(s.env) ? s.env : {};
  const env = Object.assign({}, env0);
  const mine = Object.assign({}, owned || {});
  const restore = (k) => {
    const o = mine[k];
    delete mine[k];
    if (!o || env[k] !== o.set) return;   // человек поменял сам — его значение
    if (o.prev === undefined) delete env[k]; else env[k] = o.prev;
  };
  const put = (k, v) => {
    const o = mine[k];
    // prev — то, что стояло ДО нас: при повторной записи берём из памяти, а не из файла.
    const prev = o && env[k] === o.set ? o.prev : env[k];
    env[k] = v;
    mine[k] = { set: v, prev };
  };

  if (want == null) {
    for (const k of Object.keys(mine)) restore(k);
  } else if (want) {
    for (const k of PROXY_KEYS) put(k, want);
    for (const k of NO_PROXY_KEYS) {
      const o = mine[k];
      const base = o && env[k] === o.set ? o.prev : env[k];
      put(k, mergeNoProxy(base));
    }
  } else {
    // Напрямую. Свой прокси, вписанный человеком в эти настройки руками, — его выбор: не
    // затираем. Пустым закрываем только унаследованное от оболочки.
    for (const k of PROXY_KEYS) {
      const o = mine[k];
      const foreign = env[k] !== undefined && !(o && env[k] === o.set);
      if (foreign && String(env[k]).trim()) { delete mine[k]; continue; }
      put(k, '');
    }
    for (const k of NO_PROXY_KEYS) restore(k);
  }

  const next = Object.assign({}, s);
  if (Object.keys(env).length) next.env = env; else delete next.env;
  const changed = JSON.stringify(next) !== JSON.stringify(s);
  return { settings: next, owned: mine, changed };
}

module.exports = { PROXY_KEYS, NO_PROXY_KEYS, wanted, apply, stemOf };
