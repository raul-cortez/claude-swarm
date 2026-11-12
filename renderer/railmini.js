// railmini.js — подписи свёрнутой левой панели: инициалы карточки и сокращение папки.
// Dual-mode, как tabstyle.js: window.SWARM_RAILMINI в окне, module.exports под Node (тест).
// Здесь только строки — DOM и CSS живут в renderer.js / styles.css.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_RAILMINI = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Слова — непрерывные куски букв и цифр любого алфавита: дефис, подчёркивание, точка,
  // пробел и эмодзи их разделяют.
  function words(s) {
    return String(s == null ? '' : s).match(/[\p{L}\p{N}]+/gu) || [];
  }

  // Карточка → две заглавные буквы. Два слова и больше — первые буквы двух первых
  // («Окно оплаты» → ОО); одно слово — его первые две буквы («claude» → CL).
  function tabInitials(name) {
    const w = words(name);
    if (!w.length) return '·';
    const chars = (x) => Array.from(x);
    const pick = w.length >= 2
      ? chars(w[0])[0] + chars(w[1])[0]
      : chars(w[0]).slice(0, 2).join('');
    return pick.toUpperCase();
  }

  // Заголовок папки → до трёх заглавных: первые буквы частей имени
  // (`payments-gateway-v2` → PGV, `marketing-site` → MS); одно слово — его первые три буквы.
  function folderAbbr(name) {
    const w = words(name);
    if (!w.length) return '·';
    const chars = (x) => Array.from(x);
    const pick = w.length >= 2
      ? w.slice(0, 3).map((x) => chars(x)[0]).join('')
      : chars(w[0]).slice(0, 3).join('');
    return pick.toUpperCase();
  }

  return { tabInitials, folderAbbr };
});
