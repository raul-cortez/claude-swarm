'use strict';
// subs.js — ПОДПИСКИ: чем открываются вкладки и что из их расхода видно в нижней панели.
// План: docs/superpowers/plans/2026-08-26-subscriptions-page-and-bar.md
//
// Подписка здесь — карточка: строка запуска, имя и галка «показывать остатки в панели».
// Список карточек И ЕСТЬ список запуска: раньше он жил на странице «Запуск» безымянными
// строчками команд, и человек, у которого два аккаунта Клода, видел в меню «+» два почти
// одинаковых `claude` и `claude-my` без подсказки, какой из них личный.
//
// Главное решение модуля: МЫ НЕ РЕШАЕМ ПО ИМЕНИ, подписка это или нет. Догадка по стему
// («claude», «cld», всё на «claude-») врёт ровно в интересных случаях: `claude-glm` и `cld` —
// обёртки к чужим моделям, имя клодовое, а окон лимитов Anthropic у них нет; и наоборот,
// алиас личного аккаунта человек может назвать как угодно. Настоящий признак приходит от
// самого Клода: rate_limits есть только на подписке и только с первого ответа модели. Поэтому
// галка живая у любой карточки, а пилюля появляется, когда пришли ЧИСЛА.
//
// Оттуда же карточка узнаёт свою папку конфига: вкладка отработала → в снимке расхода написан
// её home → сопоставление «эта строка запуска живёт в этом конфиге» запомнено (learnHome).
// Читать алиасы шелла для этого не нужно, а прочитать их и нечем.
//
// Только чистые функции: ни DOM, ни файлов, ни Electron. Снимки расхода читает main.js,
// рисует пилюли renderer.js, а решения — «какую карточку показать, каким числом и с каким
// временем сброса» — здесь, потому что их три читателя (панель, список по клику, предпросмотр
// в настройках) и разойтись им нельзя.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_SUBS = api;
})(typeof self !== 'undefined' ? self : this, function () {

// --- пороги -------------------------------------------------------------------
// Те же числа, что у строки статуса (swarm-statusline.js) и у ворот на подагентов
// (hooks/swarm-signal.mjs). Разойдись они — и панель говорила бы «всё в порядке» в тот
// момент, когда хук уже запрещает агенту подагентов.
const TIGHT = 75;   // % израсходовано: пилюля янтарная, время сброса становится нужным
const CRIT = 90;    // % израсходовано: пилюля красная

// Какое окно показывать в панели и когда показывать время сброса.
//
// По умолчанию — ОБА окна. Одно число («то, что ближе к концу») было тише и уже на шестьдесят
// пикселей, но отвечало не на тот вопрос: человек смотрит в панель, чтобы знать свой запас
// целиком, а не худшую из двух цифр, — и второе окно приходилось разворачивать кликом, зная,
// что оно там есть. Оставшиеся положения на месте: кому панель дороже, тот выберет одно число.
// Отсчёт до сброса, наоборот, по умолчанию молчит: пока запаса хватает, он ничего не решает.
const WINDOWS = ['both', 'worst', 'five', 'seven'];
const ETAS = ['tight', 'always', 'never'];
// Как выделять пилюлю, когда лимит на исходе (spent >= TIGHT). «numbers» по умолчанию: заливка
// всей пилюли (`fill`) слишком режет глаз для панели, на которую смотрят мимоходом, а «не
// выделять» (`none`) прячет сигнал совсем — цифры остаются нейтральными, что вопрос «сколько
// осталось» задаёт снова экран настроек, а не глаз.
const HIGHLIGHT = ['none', 'numbers', 'fill'];
const VIEW = { window: 'both', eta: 'tight', highlight: 'numbers' };

function view(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  return {
    window: WINDOWS.includes(v.window) ? v.window : VIEW.window,
    eta: ETAS.includes(v.eta) ? v.eta : VIEW.eta,
    highlight: HIGHLIGHT.includes(v.highlight) ? v.highlight : VIEW.highlight,
  };
}

// --- карточки -----------------------------------------------------------------
// Строка запуска целиком, как её набрал человек: `claude-my --model sonnet`. Флаги отдельным
// полем не держим намеренно — это была одна строка на странице «Запуск», человек правит её
// как строку, и разбор на «команду и флаги» нужен только запуску (см. parseAgentLine там).
function line(card) {
  return String((card && card.line) || '').trim();
}

// Первое слово строки запуска. Оно же — ярлык по умолчанию: `claude-my` понятнее пустоты.
function stemOf(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  return t.split(/\s+/)[0].replace(/^.*[/\\]/, '');
}

// Как звать эту подписку в интерфейсе: имя, если человек его дал, иначе строка запуска.
// Пустое имя — норма, а не недозаполненность: у человека с одним аккаунтом называть нечего.
function label(card) {
  const name = String((card && card.name) || '').trim();
  return name || line(card) || stemOf(line(card));
}

// Имя аккаунта, у которого карточки нет вовсе: человек набрал `claude` руками в чистом
// терминале. Берём из папки конфига — `~/.claude-my` → `claude-my`. Такой расход всё равно
// его расход, и молчать о нём хуже, чем назвать папкой.
function aliasOfHome(home) {
  const base = String(home || '').replace(/[/\\]+$/, '').replace(/^.*[/\\]/, '');
  return base.replace(/^\./, '') || 'claude';
}

// Одна карточка из чего угодно: и из нового вида, и из прежнего списка запуска
// ({ cmd, flags }) — тот лежит у каждого, кто уже пользуется приложением, и потерять его
// значит открыть человеку вкладки не тем агентом.
function card(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const text = r.line != null
    ? String(r.line)
    : [String(r.cmd || '').trim(), String(r.flags || '').trim()].filter(Boolean).join(' ');
  return {
    line: String(text || '').trim(),
    name: String(r.name || '').trim(),
    // Показывать остатки — по умолчанию ДА: человек, у которого подписка одна, не должен
    // включать её расход руками, чтобы увидеть то, о чём и просил.
    bar: r.bar === undefined ? true : !!r.bar,
    // Выученная папка конфига. Пусто — ещё не видели ни одного хода этой строки.
    home: String(r.home || '').trim(),
  };
}

function cards(raw) {
  const list = Array.isArray(raw) ? raw.map(card).filter((c) => c.line) : [];
  return list;
}

// --- сопоставление карточка ↔ аккаунт -----------------------------------------
// Аккаунт приходит из снимков расхода: { home, five, seven, at, lines } — где lines это
// строки запуска вкладок, которые в этом конфиге работали. Ищем карточку сначала по
// ЗАПОМНЕННОМУ home (точно), потом по строке запуска (так и запоминаем в первый раз).
//
// Сравниваем по стему, а не по всей строке: у одной подписки бывает несколько карточек
// (`claude` и `claude --model opus`), и обе живут в одном конфиге.
function matchIndex(list, account) {
  const cs = Array.isArray(list) ? list : [];
  const home = String((account && account.home) || '').trim();
  if (home) {
    const byHome = cs.findIndex((c) => c.home && c.home === home);
    if (byHome !== -1) return byHome;
  }
  const stems = new Set((((account && account.lines) || [])).map((l) => stemOf(l)).filter(Boolean));
  if (!stems.size) return -1;
  return cs.findIndex((c) => stems.has(stemOf(c.line)));
}

// Запомнить папку конфига в карточке, узнав её из снимка. Возвращает НОВЫЙ список, если
// что-то изменилось, и тот же — если нет: рендерер по этому и решает, сохранять ли.
function learnHome(list, accounts) {
  const cs = Array.isArray(list) ? list.slice() : [];
  let changed = false;
  for (const acc of Array.isArray(accounts) ? accounts : []) {
    const home = String((acc && acc.home) || '').trim();
    if (!home) continue;
    const i = matchIndex(cs, acc);
    if (i === -1 || cs[i].home === home) continue;
    cs[i] = Object.assign({}, cs[i], { home });
    changed = true;
  }
  return changed ? cs : list;
}

// --- что показывать в панели --------------------------------------------------
function levelOf(spent) {
  const n = Number(spent);
  if (!isFinite(n)) return '';
  if (n >= CRIT) return 'crit';
  if (n >= TIGHT) return 'tight';
  return '';
}

// «2ч14м» / «18м» / «3д4ч» — грубо намеренно: это отсчёт до сброса через часы или дни, и
// секунды в нём были бы шумом. Двойник этой функции живёт в swarm-statusline.js (fmtEta) и
// обязан говорить то же самое — статуслайн копируется в userData отдельным файлом и требовать
// оттуда наш модуль нечем. За совпадением следит test/subs.test.js.
function fmtEta(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}д${h}ч` : `${d}д`;
  if (h > 0) return m > 0 ? `${h}ч${m}м` : `${h}ч`;
  return `${m}м`;
}

// Точное время сброса словами — для списка по клику. Там человек ищет «когда можно будет
// работать», и часы на стене отвечают на это лучше отсчёта: отсчёт надо перечитывать.
const DAYS = ['в воскресенье', 'в понедельник', 'во вторник', 'в среду', 'в четверг', 'в пятницу', 'в субботу'];

function fmtWhen(atMs, nowMs) {
  const at = Number(atMs);
  if (!isFinite(at) || at <= 0) return '';
  const d = new Date(at);
  const clock = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const now = new Date(Number(nowMs) || Date.now());
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  if (sameDay) return `в ${clock}`;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const isTomorrow = d.getFullYear() === tomorrow.getFullYear() && d.getMonth() === tomorrow.getMonth()
    && d.getDate() === tomorrow.getDate();
  if (isTomorrow) return `завтра в ${clock}`;
  return `${DAYS[d.getDay()]}, ${clock}`;
}

// Числительное + правильная форма слова: «1 час»/«2 часа»/«5 часов». Обычное русское
// склонение — по последней цифре, но 11-14 всегда «много», сколько бы раз это ни повторилось
// в старших разрядах.
function pluralRu(n, forms) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return forms[0];
  if (n10 >= 2 && n10 <= 4 && !(n100 >= 12 && n100 <= 14)) return forms[1];
  return forms[2];
}

// «через 2 часа 15 минут» — отсчёт словами, а не часами на стене. Для списка по клику это
// нужно там, где до сброса меньше суток: пятичасовое окно всегда такое, недельное — в
// последние сутки перед сбросом (см. fmtResetWhen). Секунды — шум на этом масштабе, как и в
// fmtEta, поэтому округляем до минут.
function fmtRel(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (!h && !m) return 'через минуту';
  const hPart = h ? `${h} ${pluralRu(h, ['час', 'часа', 'часов'])}` : '';
  const mPart = m ? `${m} ${pluralRu(m, ['минуту', 'минуты', 'минут'])}` : '';
  return 'через ' + [hPart, mPart].filter(Boolean).join(' ');
}

const DAY_SECONDS = 86400;

// Что печатать в списке по клику для ОДНОГО окна. Пятичасовое — всегда словами («через 2 часа
// 15 минут»): часы на стене для окна короче суток надо пересчитывать в уме. Недельное — гибко:
// меньше суток до сброса — тот же счёт словами, иначе точное время (fmtWhen: «завтра в 09:30»
// или «в четверг, 14:00») — там до сброса далеко, и час на стене планировать удобнее отсчёта.
function fmtResetWhen(atMs, nowMs, alwaysRel) {
  const at = Number(atMs);
  if (!isFinite(at) || at <= 0) return '';
  const now = Number(nowMs) || Date.now();
  const leftSec = (at - now) / 1000;
  if (alwaysRel || (leftSec > 0 && leftSec < DAY_SECONDS)) return fmtRel(leftSec);
  return fmtWhen(at, now);
}

// То же самое, только про момент в ПРОШЛОМ — для окна, чей resetsAt уже наступил, а свежего
// снимка так и не было (windowRow().stale). fmtResetWhen() тут не годится: она считает leftSec
// от «сейчас», и для отрицательного результата fmtRel() зажимает секунды в 0 — «обновится через
// минуту», ложное «вот-вот» для окна, которое на самом деле зависло. fmtWhen() же не смотрит на
// знак разницы вовсе — сутки назад ли, через сутки — и показывает точное время часами на стене,
// поэтому её можно звать как есть.
function fmtStaleSince(atMs, nowMs) {
  const at = Number(atMs);
  if (!isFinite(at) || at <= 0) return '';
  const now = Number(nowMs) || Date.now();
  const agoSec = (now - at) / 1000;
  const when = agoSec >= 0 && agoSec < DAY_SECONDS
    ? fmtRel(agoSec).replace(/^через /, '') + ' назад'
    : fmtWhen(at, now);
  return `должно было обновиться ${when}`;
}

// Одно окно к показу: { lab, spent, level, eta, resetsAt, stale }. Пусто — окна нет в снимке
// (Клод присылает их только по подписке), и тогда показывать нечего: ноль вместо неизвестного —
// вранье.
//
// stale — окно уже должно было сброситься (resetsAt в прошлом), а свежего снимка так и не
// пришло: значит spent гарантированно неверен (реальный неизвестен, а не «примерно такой же»).
// Типичная причина — на этой подписке давно не запускали агентов (например, исчерпан недельный
// лимит, и дальше на ней просто не работают), поэтому main.js subsAccounts() не видит новых
// снимков. Это не эвристика по давности последнего снимка — а точный факт по самому этому окну:
// нет отдельного порога/константы, потому что не нужны. Устаревшему окну level форсируется в ''
// — красить пилюлю в tight/crit по неизвестному текущему уровню так же нечестно, как показать
// сам процент.
function windowRow(lab, limit, opts) {
  const spent = limit && isFinite(Number(limit.spent)) ? Math.max(0, Math.min(100, Math.round(Number(limit.spent)))) : null;
  if (spent == null) return null;
  const nowSec = Math.floor((Number(opts && opts.now) || Date.now()) / 1000);
  const resets = limit && isFinite(Number(limit.resetsAt)) ? Number(limit.resetsAt) : 0;
  const stale = resets > 0 && resets <= nowSec;
  const level = stale ? '' : levelOf(spent);
  const left = resets > nowSec ? resets - nowSec : 0;
  const mode = (opts && opts.eta) || VIEW.eta;
  const wantEta = mode === 'always' || (mode === 'tight' && spent >= TIGHT);
  return {
    lab,
    spent,
    level,
    eta: wantEta && left ? fmtEta(left) : '',
    resetsAt: resets ? resets * 1000 : 0,
    stale,
  };
}

// Общий для pills()/previewPills(): итоговая рамка пилюли — самый строгий уровень её окон.
function worstLevel(items) {
  return items.reduce((acc2, it) => (it.level === 'crit' ? 'crit'
    : (it.level === 'tight' && acc2 !== 'crit' ? 'tight' : acc2)), '');
}

// Пилюли для панели, по одной на подписку. Порядок — как в карточках: человек сам его выбрал,
// а сортировка «по расходу» переставляла бы их под курсором ровно в тот момент, когда одна
// из подписок подходит к концу.
//
// Аккаунт без карточки показываем тоже (см. aliasOfHome): это его расход, и промолчать о нём
// хуже, чем назвать папкой. Убрать его из панели можно единственным способом — завести ему
// карточку и снять галку: другого выключателя у подписки нет, и второго быть не должно.
function pills(state) {
  const s = state || {};
  const v = view(s.view);
  const list = cards(s.cards);
  const now = Number(s.now) || Date.now();
  const out = [];
  const accounts = (Array.isArray(s.accounts) ? s.accounts : []).filter((a) => a && a.home);
  // Сначала аккаунты в порядке карточек, потом безкарточные — иначе чужой `claude`, набранный
  // руками, влезал бы в середину и переставлял привычные пилюли.
  const ordered = [];
  for (const c of list) {
    const acc = accounts.find((a) => matchIndex([c], a) === 0);
    if (acc && !ordered.includes(acc)) ordered.push(acc);
  }
  for (const a of accounts) if (!ordered.includes(a)) ordered.push(a);

  for (const acc of ordered) {
    const i = matchIndex(list, acc);
    const own = i === -1 ? null : list[i];
    if (own && own.bar === false) continue;
    const five = windowRow('5ч', acc.five, { now, eta: v.eta });
    const seven = windowRow('7д', acc.seven, { now, eta: v.eta });
    let items = [];
    if (v.window === 'both') items = [five, seven].filter(Boolean);
    else if (v.window === 'five') items = [five].filter(Boolean);
    else if (v.window === 'seven') items = [seven].filter(Boolean);
    else {
      // «то, что ближе к концу» — по расходу, а не по длине окна: недельное упирается
      // раньше пятичасового ровно тогда, когда человек работал всю неделю.
      const worst = (five && seven) ? (five.spent >= seven.spent ? five : seven) : (five || seven);
      items = worst ? [worst] : [];
    }
    if (!items.length) continue;      // числа не пришли — пилюли нет вовсе
    out.push({
      home: String(acc.home),
      label: own ? label(own) : aliasOfHome(acc.home),
      named: !!(own && String(own.name || '').trim()),
      items,
      level: worstLevel(items),
      at: Number(acc.at) || 0,
    });
  }
  return out;
}

// Условные цифры для предпросмотра в настройках — только чтобы показать ФОРМУ пилюли (окна,
// цвет рамки, время сброса), пока настоящих чисел ещё нет. Не расход: реальный расход приходит
// только от Клода и только с первого ответа модели (см. заголовок файла).
const DEMO = {
  five: { spent: 42, left: 2 * 3600 + 30 * 60 },   // 2ч30м до сброса
  seven: { spent: 58, left: 3 * 86400 + 12 * 3600 }, // 3д12ч до сброса
};

function demoWindowRow(lab, key, eta) {
  const d = DEMO[key];
  const level = levelOf(d.spent);
  const wantEta = eta === 'always' || (eta === 'tight' && d.spent >= TIGHT);
  return { lab, spent: d.spent, level, eta: wantEta ? fmtEta(d.left) : '', resetsAt: 0, demo: true };
}

// Предпросмотр в настройках: та же форма, что покажет панель, для карточек, которые правит
// сейчас человек, — ДАЖЕ если по ним ещё не пришло ни одного настоящего числа (тогда окна
// условные, см. DEMO, и пилюля помечена `demo: true`, чтобы рендерер не выдал их за расход).
// Настоящие числа, если уже пришли, в предпросмотре тоже настоящие — обманывать смысла нет.
function previewPills(state) {
  const s = state || {};
  const v = view(s.view);
  const list = cards(s.cards);
  const now = Number(s.now) || Date.now();
  const accounts = (Array.isArray(s.accounts) ? s.accounts : []).filter((a) => a && a.home);
  const out = [];
  const used = new Set();

  for (const c of list) {
    if (c.bar === false) continue;
    const acc = accounts.find((a) => matchIndex([c], a) === 0) || null;
    if (acc) used.add(acc);
    const realFive = acc ? windowRow('5ч', acc.five, { now, eta: v.eta }) : null;
    const realSeven = acc ? windowRow('7д', acc.seven, { now, eta: v.eta }) : null;
    const five = realFive || demoWindowRow('5ч', 'five', v.eta);
    const seven = realSeven || demoWindowRow('7д', 'seven', v.eta);
    let items;
    if (v.window === 'five') items = [five];
    else if (v.window === 'seven') items = [seven];
    else if (v.window === 'worst') items = [five.spent >= seven.spent ? five : seven];
    else items = [five, seven];
    out.push({
      home: acc ? String(acc.home) : '',
      label: label(c),
      named: !!String(c.name || '').trim(),
      items,
      level: worstLevel(items),
      at: acc ? Number(acc.at) || 0 : 0,
      demo: !(realFive || realSeven),
    });
  }

  // Аккаунт без карточки (набрали руками в чистом терминале) — как в pills(): показываем,
  // только если числа по нему уже настоящие пришли; выдумывать окна тому, чью карточку
  // человек прямо сейчас даже не открыл, незачем.
  for (const acc of accounts) {
    if (used.has(acc)) continue;
    const five = windowRow('5ч', acc.five, { now, eta: v.eta });
    const seven = windowRow('7д', acc.seven, { now, eta: v.eta });
    let items = [];
    if (v.window === 'both') items = [five, seven].filter(Boolean);
    else if (v.window === 'five') items = [five].filter(Boolean);
    else if (v.window === 'seven') items = [seven].filter(Boolean);
    else { const worst = (five && seven) ? (five.spent >= seven.spent ? five : seven) : (five || seven); items = worst ? [worst] : []; }
    if (!items.length) continue;
    out.push({
      home: String(acc.home),
      label: aliasOfHome(acc.home),
      named: false,
      items,
      level: worstLevel(items),
      at: Number(acc.at) || 0,
      demo: false,
    });
  }
  return out;
}

// Строки для списка по клику: ВСЕ известные подписки, оба окна, точное время сброса. Список
// только РАССКАЗЫВАЕТ — ни галочек, ни настроек в нём нет. Переключатель у подписки один, на её
// карточке в настройках; два выключателя одного и того же — это вопрос «какой из них главный»,
// который человеку задавать незачем.
function menuRows(state) {
  const s = state || {};
  const list = cards(s.cards);
  const now = Number(s.now) || Date.now();
  const accounts = (Array.isArray(s.accounts) ? s.accounts : []).filter((a) => a && a.home);
  const rows = [];
  const seen = new Set();

  const rowOf = (own, acc) => {
    const five = acc ? windowRow('5ч', acc.five, { now, eta: 'never' }) : null;
    const seven = acc ? windowRow('7д', acc.seven, { now, eta: 'never' }) : null;
    return {
      home: acc ? String(acc.home) : (own ? own.home : ''),
      line: own ? own.line : '',
      label: own ? label(own) : aliasOfHome(acc && acc.home),
      // Висит ли она сейчас в панели. Не переключатель, а пояснение к тому, что человек видит:
      // снятая галка на карточке иначе выглядела бы как пропавшая подписка.
      inBar: own ? own.bar !== false : true,
      // Есть ли что показывать. Нет — это не ошибка: окна приходят только по подписке и
      // только с первого ответа модели.
      known: !!(five || seven),
      five,
      seven,
      when: {
        five: five ? (five.stale ? fmtStaleSince(five.resetsAt, now) : fmtResetWhen(five.resetsAt, now, true)) : '',
        seven: seven ? (seven.stale ? fmtStaleSince(seven.resetsAt, now) : fmtResetWhen(seven.resetsAt, now, false)) : '',
      },
    };
  };

  for (const own of list) {
    const acc = accounts.find((a) => matchIndex([own], a) === 0) || null;
    if (acc) seen.add(acc.home);
    rows.push(rowOf(own, acc));
  }
  for (const acc of accounts) {
    if (seen.has(acc.home)) continue;
    rows.push(rowOf(null, acc));
  }
  return rows;
}

// Имя подписки для АГЕНТА: он получает числа хуком в начало хода и до сих пор не знал, чьи
// они. Пусто — имени нет (карточки нет или человек его не дал), и тогда хук ничего не
// придумывает: соврать про аккаунт хуже, чем промолчать.
function nameForHome(list, home) {
  const h = String(home || '').trim();
  if (!h) return '';
  const found = cards(list).find((c) => c.home === h && String(c.name || '').trim());
  return found ? String(found.name).trim() : '';
}

return {
  TIGHT, CRIT, WINDOWS, ETAS, HIGHLIGHT, VIEW,
  view, card, cards, line, label, stemOf, aliasOfHome,
  matchIndex, learnHome, levelOf, fmtEta, fmtWhen, fmtRel, fmtResetWhen, fmtStaleSince, pluralRu, windowRow,
  pills, previewPills, menuRows, nameForHome,
};

});
