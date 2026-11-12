// historyview.js — окно прошлых разговоров: строки, поиск и подпись даты. Dual-mode, как railmini.js:
// window.SWARM_HISTORYVIEW в окне, module.exports под Node (тест). Здесь только данные —
// DOM и CSS живут в renderer.js / styles.css.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_HISTORYVIEW = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Строка списка из того, что нашёл диск (f), и своей записи окна о разговоре (rec, может не быть).
  // name — как звалась вкладка, иначе имя из разговора, иначе первая просьба; about — что показать
  // под именем: саммари (чем занимались вообще), нет его — дайджест, нет и его — первая просьба.
  function row(f, rec) {
    const r = rec || {};
    const name = r.name || f.title || f.prompt;
    const about = r.summary || r.digest || (name !== f.prompt ? f.prompt : '');
    return { id: f.id, at: f.at, cwd: f.cwd || r.cwd || '', name, about, noname: name === f.prompt,
      hay: [name, r.summary, r.digest, f.prompt, f.title].filter(Boolean).join('\n').toLowerCase() };
  }

  // Поиск: слова через пробел, все должны встретиться где-то в имени, саммари, дайджесте или
  // первой просьбе (регистр не важен). Пустой запрос — всё как есть.
  function filter(rows, query) {
    const words = String(query == null ? '' : query).toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return rows;
    return rows.filter((r) => words.every((w) => r.hay.includes(w)));
  }

  const SHORT = ['янв.', 'фев.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сен.', 'окт.', 'ноя.', 'дек.'];
  const two = (n) => (n < 10 ? '0' : '') + n;

  // Дата разговора: «12 ноя., 18:43»; чужой год — с годом («31 дек. 2025, 22:10»).
  function when(ms, now) {
    const d = new Date(ms);
    const cur = new Date(now == null ? Date.now() : now);
    const year = d.getFullYear() !== cur.getFullYear() ? ' ' + d.getFullYear() : '';
    return d.getDate() + ' ' + SHORT[d.getMonth()] + year + ', ' + two(d.getHours()) + ':' + two(d.getMinutes());
  }

  return { row, filter, when };
});
