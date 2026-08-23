// tabstyle.js — tab card appearance data + pure helpers. Dual-mode: attaches to
// window.SWARM_TABSTYLE in the browser (loaded via <script> before renderer.js),
// and exports via module.exports under Node so test/tabstyle.test.js can require it.
// NO DOM here — just data and validation, so it's unit-testable in Node.
//
// Density is applied as a CLASS (it flips a batch of CSS vars declared in
// styles.css, включая размеры текста); colors are applied as CSS VARS. Keep that
// split — it's why toCssVars() emits only the four status colors and bodyClasses()
// owns the rest.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_TABSTYLE = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DENSITIES = [
    { id: 'compact', name: 'Компактная' },
    { id: 'normal', name: 'Обычная' },
    { id: 'roomy', name: 'Просторная' },
  ];

  // Четыре состояния работы — и всё. Цвета «активной вкладки» здесь нет: открытая
  // вкладка обводится цветом СВОЕГО статуса (styles.css, --tab-c), поэтому отдельный
  // цвет ей не нужен. Пока он был пятой пипеткой, он ещё и совпадал с ожиданием — в
  // ряду это читалось как баг, а по смыслу он вообще не статус: тем же --accent
  // покрашены кнопки, рамка фокуса и ползунки. Акцент интерфейса остался
  // фиксированным в styles.css: это оформление, а не состояние сессии.
  const COLORS = [
    { key: 'run', name: 'Работает' },
    { key: 'ready', name: 'Готова' },
    { key: 'waiting', name: 'Ждёт ввода' },
    { key: 'danger', name: 'Ошибка' },
  ];

  // Как карточка показывает статус. Это ОДИН выбор, а не две галочки: точка и
  // заливка — два способа сказать одно и то же, и парой переключателей они делали
  // дырку «выключил оба — статуса не видно» и заставляли выбирать дважды.
  const STATUS_STYLES = [
    { id: 'dot', name: 'Точкой' },
    { id: 'fill', name: 'Заливкой карточки' },
    { id: 'both', name: 'Точкой и заливкой' },
  ];

  // Что ещё показывать на карточке. Значок сабагентов сюда НЕ входит: он и так
  // виден только когда сабагенты работают, выключать было нечего. «Оранжевый, пока
  // работает сабагент» тоже ушёл — это не вид карточки, а честность статуса.
  const SHOW_KEYS = ['ctx', 'sub'];

  // Colors mirror the hardcoded :root palette (styles.css:10-22) — pinned by a
  // regression test, so a change there must be mirrored here.
  const DEFAULT_TABSTYLE = {
    density: 'normal',
    status: 'both',
    show: { ctx: true, sub: true },
    colors: {
      run: '#e0a53f',
      ready: '#4ade80',
      waiting: '#3fd0c9',
      danger: '#e05a5a',
    },
  };

  const HEX = /^#[0-9a-fA-F]{6}$/;

  // Coerce any stored/garbage value into a valid tab style. Never throws.
  // Returns a deep copy, so callers can use it to fork an editable draft.
  function normalizeTabStyle(raw) {
    const d = DEFAULT_TABSTYLE;
    const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const rShow = (r.show && typeof r.show === 'object') ? r.show : {};
    const rColors = (r.colors && typeof r.colors === 'object') ? r.colors : {};
    const show = {};
    SHOW_KEYS.forEach(function (k) {
      show[k] = typeof rShow[k] === 'boolean' ? rShow[k] : d.show[k];
    });
    // Переезд со старой формы, где точка и заливка были двумя галочками. Читаем их
    // из сохранённого show, чтобы у человека осталось то, что он выбирал: были обе —
    // 'both', только заливка — 'fill', только точка — 'dot'. Ни одной — 'dot': такое
    // сочетание раньше означало «без цвета вообще», и точка здесь тише всего.
    let status = STATUS_STYLES.some(function (x) { return x.id === r.status; }) ? r.status : null;
    if (!status) {
      const oldDot = typeof rShow.dot === 'boolean' ? rShow.dot : true;
      const oldFill = typeof rShow.statusFill === 'boolean' ? rShow.statusFill : true;
      status = (oldDot && oldFill) ? 'both' : (oldFill ? 'fill' : 'dot');
    }
    const colors = {};
    COLORS.forEach(function (c) {
      const v = rColors[c.key];
      colors[c.key] = (typeof v === 'string' && HEX.test(v)) ? v.toLowerCase() : d.colors[c.key];
    });
    return {
      density: DENSITIES.some(function (x) { return x.id === r.density; }) ? r.density : d.density,
      status: status,
      show: show,
      colors: colors,
    };
  }

  // Colors → CSS custom properties. Normalizes first, so a caller can pass a
  // half-built draft without leaking garbage into the stylesheet. Размеры текста
  // сюда больше не входят: их несёт пресет плотности (styles.css), а два шаговика
  // рядом с «Плотностью» заставляли согласовывать вручную то, что должно ехать вместе.
  function toCssVars(style) {
    const s = normalizeTabStyle(style);
    const out = {};
    COLORS.forEach(function (c) { out['--' + c.key] = s.colors[c.key]; });
    return out;
  }

  // Density + visibility → class names. Order is stable (density first) so the
  // result can be compared verbatim in tests.
  function bodyClasses(style) {
    const s = normalizeTabStyle(style);
    const out = ['tabs-' + s.density];
    if (s.status === 'fill') out.push('tab-no-dot');
    if (s.status === 'dot') out.push('tab-no-fill');
    if (!s.show.ctx) out.push('tab-no-ctx');
    if (!s.show.sub) out.push('tab-no-sub');
    return out;
  }

  return { DENSITIES, COLORS, STATUS_STYLES, DEFAULT_TABSTYLE, normalizeTabStyle, toCssVars, bodyClasses };
});
