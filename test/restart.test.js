// Plain-node tests for the self-restart helpers (restart.js).
// Цена ошибки здесь выше обычной: неверное «пора» перезапускает вкладку на середине работы,
// а неверный разбор ответа — стартует свежую сессию без задачи. Поэтому проверяем не только
// счастливый путь, но каждую причину НЕ перезапускать.
const assert = require('assert');
const R = require('../restart.js');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const HOUR = 3600 * 1000;
// Вкладка, которую спрашивать МОЖНО: работает давно, контекст за порогом.
function ready(over) {
  return { pct: 40, status: 'ready', startedAt: 1000, ...over };
}
test('effectivePct зажат диапазоном 15–75', () => {
  assert.strictEqual(R.effectivePct(1, 7), 15, 'совсем лёгкий проект — упирается в пол');
  assert.strictEqual(R.effectivePct(5, 7), 35);
  assert.strictEqual(R.effectivePct(20, 7), 75, 'совсем тяжёлый проект — упирается в потолок');
});

// Раньше "не задано" тихо превращалось в самый агрессивный порог (Number(null) === 0, а 0 —
// законное значение ползунка) — новый человек получал бы перезапуски вдвое чаще обещанного,
// молча. Здесь цена такой же тихой подмены выше: пришлось бы решать "пора спрашивать" на
// вкладке, у которой ещё не было ни одного снимка контекста. Поэтому — null, а не умолчание.
test('effectivePct без известного baseline — null, а не умолчание', () => {
  assert.strictEqual(R.effectivePct(null, 7), null);
  assert.strictEqual(R.effectivePct(undefined, 7), null);
  assert.strictEqual(R.effectivePct(0, 7), null);
  assert.strictEqual(R.effectivePct(-5, 7), null);
  assert.strictEqual(R.effectivePct('нет', 7), null);
});

test('effectivePct берёт множитель по умолчанию, если свой не передали', () => {
  assert.strictEqual(R.effectivePct(5), R.effectivePct(5, R.DEFAULT_MULT));
  assert.strictEqual(R.effectivePct(5, 0), R.effectivePct(5, R.DEFAULT_MULT), 'нулевой множитель — тоже не задан');
});

// --- автомат ------------------------------------------------------------------
// Пять проходов ревью нашли 38 замечаний, и 35 из них — в main.js, где эти же решения лежали
// вразброс. Здесь каждый найденный сценарий стал проверкой: «ревью нашло путь X» превращается в
// «тест покрывает путь X».
const NOW = 10 * HOUR;
// baselinePct: 5 → эффективный порог 5×7=35 (клампы 15/75 не задействованы) — дефолтный
// pct: 40 из sig() по-прежнему "за порогом", как раньше при threshold: 30.
// Вкладка, которую спрашивать МОЖНО: контекст за порогом, покой, агент на месте, отработала час.
function sig(over) {
  return {
    now: NOW, enabled: true, baselinePct: 5, pct: 40, status: 'ready',
    dialog: false, shellBusy: true, modeVisible: true, uptimeMs: HOUR,
    hasBase: true, hasLine: false, answer: null, ...over,
  };
}
const idle = () => R.initial();
const step = (state, over) => R.step(state, sig(over));

test('порог пройден — спрашиваем', () => {
  const r = step(idle());
  assert.strictEqual(r.action, 'ask');
  assert.strictEqual(r.state.phase, 'asked');
  assert.strictEqual(r.state.askedAt, NOW);
});

test('ниже порога, при выключенной функции и в немоте — молчим', () => {
  assert.strictEqual(step(idle(), { pct: 29 }).action, 'nothing');
  assert.strictEqual(step(idle(), { enabled: false }).action, 'nothing');
  assert.strictEqual(step(idle(), { pct: 40, baselinePct: 20 }).action, 'nothing');
  assert.strictEqual(R.step({ ...idle(), phase: 'muted' }, sig()).action, 'nothing');
});

// Новое покрытие: лёгкий проект должен получать вопрос РАНЬШЕ, чем при плоских 30% —
// ровно то, ради чего формула и переделана (см. спеку).
test('лёгкий baseline двигает порог ниже — спрашиваем раньше плоских 30%', () => {
  // baseline 3×7=21: pct=25 при плоском пороге 30% "за порогом" не считался бы, теперь считается.
  assert.strictEqual(step(idle(), { pct: 25, baselinePct: 3 }).action, 'ask');
});

test('baseline ещё не измерен — не спрашиваем, даже если pct высокий', () => {
  for (const baselinePct of [null, undefined, 0, -1]) {
    assert.strictEqual(step(idle(), { pct: 90, baselinePct }).action, 'nothing');
  }
});

// Ревью правки про «+ на папке»: вкладку, которую нечем поднять, спрашивать нельзя вовсе. Иначе
// круг «спросили — разрешил — не смог» идёт до утра каждые двадцать минут, и потолок молчания его
// не обрывает: разрешение обнуляет счётчик. Так живут чистый терминал, агент, набранный руками, и
// вкладка, где агента сменили руками (session:forgetLaunch стирает строку запуска).
test('нечем запускать — не спрашиваем совсем', () => {
  for (const hasBase of [false, undefined, '']) {
    assert.strictEqual(step(idle(), { hasBase }).action, 'nothing');
  }
  // И круг не начинается заново: без вопроса нет и разрешения, обнуляющего счётчик молчания.
  const r = step(idle(), { hasBase: false });
  assert.strictEqual(r.state.phase, 'idle');
  assert.strictEqual(r.note, undefined);
});

test('нет расхода — нет вопроса: статуслайн выключен или снимок протух', () => {
  for (const pct of [0, null, NaN, undefined]) {
    assert.strictEqual(step(idle(), { pct }).action, 'nothing');
  }
});

test('спрашиваем вкладку, которая отдала ход, — а работающую не трогаем', () => {
  for (const status of ['running', 'dead', null]) {
    assert.strictEqual(step(idle(), { status }).action, 'nothing');
  }
  assert.strictEqual(step(idle(), { status: 'ready' }).action, 'ask');
  // «Ждёт» — это тоже конец хода: агент попрощался зовом к человеку. В сворме так кончается
  // почти каждый ход, и пока сюда пускали только «готов», такие вкладки не спрашивались вовсе.
  assert.strictEqual(step(idle(), { status: 'waiting' }).action, 'ask');
  // «Работает в фоне» — ход отдан, вкладку разбудит фоновая задача.
  assert.strictEqual(step(idle(), { status: 'running', bg: true }).action, 'ask');
});

// Ревью, проход 3: «готов» на пустой оболочке выглядит как «готов» у отдохнувшего агента, а снимок
// расхода живёт ещё три четверти часа после того, как Клода закрыли руками. Двадцать строк просьбы
// уезжали в ШЕЛЛ, и он послушно пытался их выполнить.
test('агента в оболочке нет — не спрашиваем', () => {
  assert.strictEqual(step(idle(), { shellBusy: false }).action, 'nothing');
  // undefined — Windows, где `ps` недоступен: там решает мебель Клода на экране (см. отдельный
  // тест ниже). В sig() она видна, поэтому спрашиваем как обычно.
  assert.strictEqual(step(idle(), { shellBusy: undefined }).action, 'ask');
});

// Ревью, проход 2: рамка запроса съест просьбу, и агент её не увидит.
test('диалог на экране — просьбу не печатаем', () => {
  assert.strictEqual(step(idle(), { dialog: true }).action, 'nothing');
});

// Защёлка снизу: свежая сессия читает таск, спеку и пару файлов и на миллионном окне оказывается у
// порога, ничего не сделав. Без неё вкладка крутится в перезапусках.
test('свежая сессия не перезапускается сразу', () => {
  assert.strictEqual(step(idle(), { uptimeMs: 60_000 }).action, 'nothing');
  assert.strictEqual(step(idle(), { uptimeMs: R.MIN_UPTIME_MS + 1 }).action, 'ask');
});

test('срок «спроси через двадцать минут» уважается', () => {
  assert.strictEqual(step({ ...idle(), retryAt: NOW + 60_000 }).action, 'nothing');
  assert.strictEqual(step({ ...idle(), retryAt: NOW - 1 }).action, 'ask');
});

// Живой случай: агент сказал «через 30 минут», освободился через 10, дописал эстафету и объявил в
// чат, что готов. Никто не отреагировал — отсрочка молчит по часам, а разговор мы не читаем.
// Значит зов идёт файлом: во время отсрочки мы за ним следим (см. earlyStep).
const deferred = () => ({ ...idle(), retryAt: NOW + 20 * 60 * 1000 });

test('во время отсрочки агент может позвать перезапуск сам', () => {
  const raw = '{"restart":true,"prompt":"продолжи таск 215","handoff":"#215"}';
  const r = R.step(deferred(), sig({ answer: { raw, mtime: NOW - 5000 } }));
  assert.strictEqual(r.action, 'grant');
  assert.strictEqual(r.state.phase, 'granted');
  assert.strictEqual(r.state.at, NOW, 'срок годности разрешения считается от зова');
  assert.strictEqual(r.state.prompt, 'продолжи таск 215');
  assert.ok(/сам/.test(r.note || ''), 'человек должен увидеть, чей это был почин');
});

test('досрочный зов проходит тот же покой, что и обычное разрешение', () => {
  // Разрешение не гасит агента сразу: фаза granted ещё раз проверяет вкладку, и работающую не
  // рвёт. Иначе агент, позвавший перезапуск и взявшийся за дело, получил бы `/exit` в середине.
  const raw = '{"restart":true,"prompt":"дальше","handoff":"#215"}';
  const r = R.step(deferred(), sig({ answer: { raw, mtime: NOW }, status: 'running' }));
  assert.strictEqual(r.action, 'grant');
  const next = R.step(r.state, sig({ status: 'running', hasLine: true }));
  assert.strictEqual(next.action, 'nothing', 'работающую вкладку не гасим даже по её же зову');
});

test('досрочно можно и передумать в другую сторону — новый срок замещает прежний', () => {
  const r = R.step(deferred(), sig({ answer: { raw: '{"restart":false,"retry":45}', mtime: NOW } }));
  assert.strictEqual(r.action, 'drop');
  assert.strictEqual(r.state.phase, 'idle');
  assert.strictEqual(r.state.retryAt, NOW + 45 * 60 * 1000);
});

test('мусор во время отсрочки срока не касается', () => {
  const st = deferred();
  // Залежавшийся файл (наше удаление не прошло) и недописанный ответ — оба не зов. Отодвинуть или
  // сдвинуть из-за них обещанный переспрос значит потерять вкладку молча.
  for (const answer of [
    { raw: '{"restart":true,"prompt":"давай","handoff":"#1"}', mtime: NOW - R.ANSWER_WAIT_MS - 1 },
    { raw: '{"restart":tr', mtime: NOW },
    { raw: 'ничего похожего на JSON', mtime: NOW },
    { raw: '{"restart":true,"prompt":"давай","handoff":"#1"}', mtime: 0 },
  ]) {
    const r = R.step(st, sig({ answer }));
    assert.strictEqual(r.action, 'nothing', answer.raw.slice(0, 20));
    assert.strictEqual(r.state.retryAt, st.retryAt, 'срок сдвинулся: ' + answer.raw.slice(0, 20));
    assert.strictEqual(r.state.phase, 'idle');
  }
});

test('вкладку, которую нечем поднять, досрочный зов тоже не поднимает', () => {
  const raw = '{"restart":true,"prompt":"дальше","handoff":"#215"}';
  const r = R.step(deferred(), sig({ answer: { raw, mtime: NOW }, hasBase: false }));
  assert.strictEqual(r.action, 'nothing');
});

// Живой случай (14.08): в 16:07 спросили, к 16:17 ответа не было — отсрочка. В 20:49 агент положил
// в файл разрешение с эстафетой и промптом, и оно пролежало часами: после истёкшего срока сворм в
// файл больше не смотрел. Дождавшись переспроса, он напечатал бы двадцать строк просьбы заново — и
// тут же выбросил этот ответ как залежавшийся, добавив ещё двадцать минут.
const expired = () => ({ ...idle(), retryAt: NOW - 1 });

test('разрешение, положенное после истёкшего срока, подхватываем, а не спрашиваем заново', () => {
  const raw = '{"restart":true,"prompt":"дальше","handoff":"#215"}';
  const r = R.step(expired(), sig({ answer: { raw, mtime: NOW - 5000 } }));
  assert.strictEqual(r.action, 'grant');
  assert.strictEqual(r.state.phase, 'granted');
  assert.strictEqual(r.state.prompt, 'дальше');
  assert.strictEqual(r.state.at, NOW, 'срок годности считается от зова, а не от нашего вопроса');
  assert.ok(/сам/.test(r.note || ''), 'человеку видно, что разрешение пришло без просьбы');
});

test('после срока агент может и отказать сам — новый срок мы уважаем', () => {
  const r = R.step(expired(), sig({ answer: { raw: '{"restart":false,"retry":45}', mtime: NOW } }));
  assert.strictEqual(r.action, 'drop');
  assert.strictEqual(r.state.retryAt, NOW + 45 * 60 * 1000);
});

// Решение владельца (15.08): «сделать максимально гибко, чтобы в любой момент можно было записать
// файл, и скрипт понял, что надо перезапускать». Порог, время работы и отсрочка — причины не
// НАЧИНАТЬ разговор самим; положенный файл ими не связан. Кто его кладёт, тот и знает лучше нас:
// агент чувствует, что потерял нить, человек это видит со стороны, а процент — только догадка.
test('зов файлом работает и до порога, и на молодой вкладке', () => {
  const raw = '{"restart":true,"prompt":"дальше","handoff":"#215"}';
  for (const over of [{ pct: 20 }, { pct: 0 }, { uptimeMs: 60_000 }, { baselinePct: 20 }]) {
    const r = R.step(idle(), sig({ ...over, answer: { raw, mtime: NOW } }));
    assert.strictEqual(r.action, 'grant', JSON.stringify(over));
  }
  // А чем поднимать — по-прежнему нужно: без строки запуска перезапуск не перезапуск, а потеря.
  assert.strictEqual(R.step(idle(), sig({ hasBase: false, answer: { raw, mtime: NOW } })).action, 'nothing');
  // И выключенная галочка главнее файла: она тоже решение человека, и он вправе ждать, что
  // выключенная функция не гасит вкладки ничем.
  assert.strictEqual(R.step(idle(), sig({ enabled: false, answer: { raw, mtime: NOW } })).action, 'nothing');
});

// Немота — это «больше не спрашиваю», и только: в неё вкладка попадает, когда агент трижды не
// ответил или разрешение трижды не дожило до спокойного мига. Появившийся файл опровергает и то,
// и другое, а игнорировать написанное разрешение значит объяснять человеку, почему сворм смотрит
// мимо чёрным по белому написанного «можно».
test('из немоты вытаскивает положенный файл', () => {
  const muted = { ...idle(), phase: 'muted', silent: R.MAX_SILENT };
  const raw = '{"restart":true,"prompt":"дальше","handoff":"#215"}';
  const r = R.step(muted, sig({ answer: { raw, mtime: NOW } }));
  assert.strictEqual(r.action, 'grant');
  assert.strictEqual(r.state.phase, 'granted');
  assert.strictEqual(r.state.silent, 0, 'счётчик неответов обнуляет ответ');
  assert.ok(/молчал/.test(r.note || ''), 'человеку видно, что вкладка вышла из немоты');
  // Отказ из немоты тоже принимаем: агент ответил, значит писать файлы он может, и круг возобновлён.
  const no = R.step(muted, sig({ answer: { raw: '{"restart":false,"retry":30}', mtime: NOW } }));
  assert.strictEqual(no.action, 'drop');
  assert.strictEqual(no.state.phase, 'idle');
  assert.strictEqual(no.state.retryAt, NOW + 30 * 60 * 1000);
  // А без файла немота остаётся немотой: спрашивать мы перестали не просто так.
  assert.strictEqual(R.step(muted, sig()).action, 'nothing');
  assert.strictEqual(R.step(muted, sig()).state.phase, 'muted');
});

// Полразрешения — «можно» без промпта или без указателя на эстафету — по-прежнему отказ. Но раз
// файл теперь кладут и руками, причину надо назвать: иначе человек видит, что сворм его записку
// молча проигнорировал.
test('неполный зов отвергается с названной причиной', () => {
  const r = R.step(idle(), sig({ answer: { raw: '{"restart":true}', mtime: NOW } }));
  assert.strictEqual(r.action, 'drop');
  assert.ok(/no-prompt/.test(r.note || ''), r.note);
});

test('залежавшийся файл после срока обычному пути не мешает, но его убирают', () => {
  const raw = '{"restart":true,"prompt":"дальше","handoff":"#215"}';
  const r = R.step(expired(), sig({ answer: { raw, mtime: NOW - R.ANSWER_WAIT_MS - 1 } }));
  assert.strictEqual(r.action, 'ask', 'ответ про прошлый круг нас не перезапускает и не запирает');
  assert.strictEqual(r.dropAnswer, true, 'иначе он лежит в чужом git status и читается каждые полминуты');
  // И когда спросить пока нельзя, файл всё равно убирают: вкладка бывает занята часами.
  const busy = R.step(expired(), sig({ status: 'running', answer: { raw, mtime: NOW - R.ANSWER_WAIT_MS - 1 } }));
  assert.strictEqual(busy.action, 'nothing');
  assert.strictEqual(busy.dropAnswer, true);
});

test('недописанный ответ после срока держит просьбу, а не рождает вторую', () => {
  // Тик попал в середину записи: эстафета текстом — это килобайты. Спросить сейчас значит просить
  // дважды об одном, а стереть — уничтожить уже написанное агентом.
  const r = R.step(expired(), sig({ answer: { raw: '{"restart":tr', mtime: NOW } }));
  assert.strictEqual(r.action, 'nothing');
  assert.ok(!r.dropAnswer);
});

// Когда читать файл, решает автомат, а не условие в руках: не вовремя прочитанный ответ
// перезапускает вкладку по прошлому кругу, а не прочитанный вовремя — теряет готовое разрешение.
test('файл ответа читаем всюду, кроме уже начатого перезапуска', () => {
  const o = { now: NOW, enabled: true };
  assert.strictEqual(R.wantsAnswer({ ...idle(), phase: 'asked' }, o), true, 'ждём ответа на просьбу');
  assert.strictEqual(R.wantsAnswer({ ...idle(), retryAt: NOW + 1000 }, o), true, 'идёт отсрочка');
  assert.strictEqual(R.wantsAnswer(expired(), o), true, 'срок истёк');
  assert.strictEqual(R.wantsAnswer(idle(), o), true, 'просто простой — файл всё равно смотрим');
  assert.strictEqual(R.wantsAnswer({ ...idle(), phase: 'muted' }, o), true, 'молчим мы, а не он');
  assert.strictEqual(R.wantsAnswer(idle(), { ...o, enabled: false }), false, 'функция выключена');
  // Фазы после разрешения: там ответ уже принят и исполняется, а фаза выхода вдобавок тактуется
  // четыре раза в секунду.
  for (const phase of ['granted', 'exiting']) {
    assert.strictEqual(R.wantsAnswer({ ...idle(), phase }, o), false, phase);
  }
});

test('ждём ответа — второй раз не спрашиваем', () => {
  const asked = { ...idle(), phase: 'asked', askedAt: NOW - 60_000 };
  assert.strictEqual(step(asked).action, 'nothing');
});

// Ревью, проход 4: в режиме плана агент не может писать файлы вовсе, в ручном — упирается в
// разрешение. Ответа не будет никогда, а мы спрашивали вечно, тратя контекст на просьбы.
test('после трёх молчаний умолкаем сами', () => {
  let st = { ...idle(), phase: 'asked', askedAt: NOW - R.ANSWER_WAIT_MS - 1 };
  for (let i = 1; i < R.MAX_SILENT; i++) {
    const r = R.step(st, sig());
    assert.strictEqual(r.state.phase, 'idle');
    assert.strictEqual(r.state.silent, i);
    assert.ok(r.note.includes('нет'), 'человек должен узнать про молчание');
    st = { ...r.state, phase: 'asked', askedAt: NOW - R.ANSWER_WAIT_MS - 1 };
  }
  const last = R.step(st, sig());
  assert.strictEqual(last.state.phase, 'muted');
  assert.ok(last.note.includes('режим разрешений'), 'и про вероятную причину тоже');
});

// Ревью, проход 5: счётчик считал молчания за всю жизнь, а не подряд. Три случайных промаха за
// ночь, между которыми агент отвечал нормально, навсегда выключали функцию для вкладки.
test('успешный ответ обнуляет счётчик молчания', () => {
  const asked = { ...idle(), phase: 'asked', askedAt: NOW - 60_000, silent: 2 };
  const r = R.step(asked, sig({ answer: { raw: '{"restart":false,"retry":5}', mtime: NOW } }));
  assert.strictEqual(r.state.silent, 0);
});

test('«не сейчас» переносит вопрос на названный агентом срок', () => {
  const asked = { ...idle(), phase: 'asked', askedAt: NOW - 60_000 };
  const r = R.step(asked, sig({ answer: { raw: '{"restart":false,"retry":25}', mtime: NOW } }));
  assert.strictEqual(r.action, 'drop');
  assert.strictEqual(r.state.phase, 'idle');
  assert.strictEqual(r.state.retryAt, NOW + 25 * 60 * 1000);
});

// Ревью, проход 2: тик, попавший в середину записи, уничтожал уже дописанный агентом ответ —
// эстафета текстом это килобайты, и запись не мгновенна.
test('недописанный ответ не выбрасываем, а ждём', () => {
  const asked = { ...idle(), phase: 'asked', askedAt: NOW - 60_000 };
  const r = R.step(asked, sig({ answer: { raw: '{"restart":tr', mtime: NOW } }));
  assert.strictEqual(r.action, 'nothing');
  assert.strictEqual(r.state.phase, 'asked');
});

// Ревью, проход 2: залежавшийся ответ написан ПОЗЖЕ вопроса, поэтому сравнение с временем вопроса
// его пропускало. Случай живой: функцию выключили с висящим вопросом, агент дописал ответ, через
// сутки включили — и мы стёрли бы разговор, в котором с тех пор работали целый день.
test('ответ старше срока годности не исполняется', () => {
  const asked = { ...idle(), phase: 'asked', askedAt: NOW - 2 * HOUR };
  const raw = '{"restart":true,"prompt":"продолжи таск 215","handoff":"#215"}';
  const stale = R.step(asked, sig({ answer: { raw, mtime: NOW - R.ANSWER_WAIT_MS - 1 } }));
  assert.strictEqual(stale.action, 'drop');
  assert.ok(stale.note.includes('залежался'));
  const fresh = R.step(asked, sig({ answer: { raw, mtime: NOW } }));
  assert.strictEqual(fresh.action, 'grant');
});

test('разрешение несёт промпт и указатель на эстафету', () => {
  const asked = { ...idle(), phase: 'asked', askedAt: NOW - 60_000 };
  const raw = '{"restart":true,"prompt":"продолжи таск 215","handoff":"#215"}';
  const r = R.step(asked, sig({ answer: { raw, mtime: NOW } }));
  assert.strictEqual(r.action, 'grant');
  assert.strictEqual(r.state.phase, 'granted');
  assert.strictEqual(r.state.prompt, 'продолжи таск 215');
  assert.strictEqual(r.state.at, NOW);
});

// «Конец хода» наружу: main.js будит автомат вне очереди не на всякое шевеление вкладки, а ровно
// на этот переход. Раньше он будил его на любую смену состояния — а туда попадает и строка
// статуса, и текст вопроса, то есть по нескольку раз в секунду на живой вкладке, каждый раз с
// двумя снятиями экрана и чтением снимка расхода с диска. Значить «кончила ход» должно там и здесь
// одно и то же, иначе такт вне очереди либо не придёт, либо придёт тысячу раз.
test('конец хода — одно и то же понятие для автомата и для такта вне очереди', () => {
  assert.strictEqual(R.turnOver({ status: 'ready' }), true);
  assert.strictEqual(R.turnOver({ status: 'waiting' }), true, 'зов — нормальный конец хода');
  assert.strictEqual(R.turnOver({ status: 'running', bg: true }), true, 'фон разбудит сам');
  assert.strictEqual(R.turnOver({ status: 'running' }), false, 'а это настоящая работа');
});

// Ревью, проход 3, главное: между вопросом и ответом проходит до десяти минут, и вкладка успевает
// снова взяться за работу — агент дописал ответ инструментом, не закончив ход, или человек утром
// написал в неё сам. /exit уехал бы работающему агенту, а свежая сессия стартовала бы с ночным
// промптом поверх начатого разговора.
test('разрешение не исполняется, пока вкладка снова занята', () => {
  const granted = { ...idle(), phase: 'granted', at: NOW - 1000, prompt: 'дальше' };
  for (const over of [{ status: 'running' }, { dialog: true }]) {
    const r = R.step(granted, sig({ hasLine: true, ...over }));
    assert.strictEqual(r.action, 'nothing');
    assert.strictEqual(r.state.phase, 'granted', 'разрешение не выбрасываем — дождёмся тишины');
  }
  const calm = R.step(granted, sig({ hasLine: true }));
  assert.strictEqual(calm.action, 'exit');
  assert.strictEqual(calm.state.phase, 'exiting');
  assert.strictEqual(calm.state.exitAt, NOW);
});

// Единственное место, где перезапуск стоит МОЛЧА и подолгу: разрешение получено, агент попрощался
// словами «вкладку можно гасить», а она живёт дальше. Живьём это выглядело как зависшая функция и
// разбиралось только чтением журнала приложения задним числом — поэтому причину отдаём наружу.
test('простой с разрешением на руках называет свою причину', () => {
  const granted = { ...idle(), phase: 'granted', at: NOW - 1000, prompt: 'дальше' };
  const cases = [
    [{ sub: 2 }, 'sub'],
    [{ status: 'running' }, 'busy'],
    [{ dialog: true }, 'box'],
    [{ shellBusy: false }, 'gone'],
  ];
  for (const [over, hold] of cases) {
    const r = R.step(granted, sig({ hasLine: true, ...over }));
    assert.strictEqual(r.action, 'nothing');
    assert.strictEqual(r.hold, hold, `причина простоя для ${JSON.stringify(over)}`);
    assert.ok(R.holdText(hold), 'и у причины есть человеческие слова');
  }
  // Ничто не держит — причины нет, и такт кончается делом.
  assert.strictEqual(R.step(granted, sig({ hasLine: true })).action, 'exit');
});

// Живой круг: агент разрешил перезапуск, дописал эстафету и попрощался зовом — и этим зовом сам
// себя запирал. Перезапуск стоял с разрешением в руках, пока человек не ответит: вживую восемь
// минут, а ночью отвечать некому вовсе, и разрешение сгорало по сроку (трижды подряд — до немоты).
test('вкладка, закончившая ход зовом, гасится, а не ждёт человека', () => {
  const granted = { ...idle(), phase: 'granted', at: NOW - 1000, prompt: 'дальше' };
  for (const over of [{ status: 'waiting' }, { status: 'running', bg: true }]) {
    const r = R.step(granted, sig({ hasLine: true, ...over }));
    assert.strictEqual(r.action, 'exit');
    assert.strictEqual(r.state.phase, 'exiting');
  }
  // Но открытая рамка держит по-прежнему: в неё нельзя печатать, что бы ни говорил статус.
  const boxed = R.step(granted, sig({ hasLine: true, status: 'waiting', dialog: true }));
  assert.strictEqual(boxed.action, 'nothing');
});

// Claude запускает сабагентов в фоне и спокойно стоит на приглашении, пока они считают: вкладка
// «готова» по всем нашим признакам, хотя в ней крутится десяток чужих ходов. Закрой мы агента в
// такой миг — с ним умрут и они, а вместе с ними час работы, которого нет ни в одной эстафете:
// записка писалась, когда сабагенты ещё не отчитались.
test('с сабагентами не рвём, но спросить — спрашиваем', () => {
  // Спросить можно и нужно: в просьбе про них сказано, и агент сам решит, ждать ли их (см.
  // отдельный тест на текст просьбы). Молчать значило бы просто отложить перезапуск до утра.
  assert.strictEqual(step(idle(), { sub: 2 }).action, 'ask');
  // А вот гасить нельзя даже с разрешением на руках: сабагенты закроются вместе с агентом.
  const granted = { ...idle(), phase: 'granted', at: NOW - 1000, prompt: 'дальше' };
  assert.strictEqual(R.step(granted, sig({ hasLine: true, sub: 1 })).action, 'nothing');
  // Досчитали — гасим. Это отсрочка, а не отказ.
  assert.strictEqual(R.step(granted, sig({ hasLine: true, sub: 0 })).action, 'exit');
});

// Протухшее разрешение считается молчанием, и три подряд выключают перезапуск до утра. Но
// разрешение, пережидавшее сабагентов, — не молчание: вкладка работала, и держали её мы сами.
// Немота досталась бы ровно тем вкладкам, которым перезапуск нужнее всех: чем больше вкладка
// гоняет фоновых агентов, тем быстрее пухнет её контекст.
test('ожидание сабагентов не ведёт вкладку к немоте', () => {
  const stale = { ...idle(), phase: 'granted', at: NOW - R.GRANT_CALM_MS - 1, prompt: 'дальше', silent: 2 };
  const r = R.step(stale, sig({ hasLine: true, sub: 2 }));
  assert.strictEqual(r.action, 'drop');
  assert.strictEqual(r.state.phase, 'idle', 'не немота');
  assert.strictEqual(r.state.silent, 2, 'счётчик молчания не растёт');
  assert.ok(r.state.retryAt > NOW, 'и переспрос отложен, а не сразу');
  // А без сабагентов третье протухание по-прежнему выключает перезапуск до конца сессии.
  const mute = R.step(stale, sig({ hasLine: true, sub: 0 }));
  assert.strictEqual(mute.state.phase, 'muted');
});

test('про сабагентов сказано в просьбе — и только когда они есть', () => {
  const withSub = R.askText({ pct: 31, answerFile: '/tmp/a.json', sub: 3 });
  assert.ok(withSub.includes('(3)'), 'сказано, сколько их');
  assert.ok(/не переживут/.test(withSub) && /дождись/i.test(withSub));
  const without = R.askText({ pct: 31, answerFile: '/tmp/a.json' });
  assert.ok(!/фоновые агенты/.test(without), 'без сабагентов это указание ждать того, чего нет');
});

// Пока «ждёт» блокировало всё подряд, рамка запроса была прикрыта дважды. Теперь зов сквозь эту
// проверку проходит — и запрос РАЗРЕШЕНИЯ остался бы на одном скрёбе экрана. Промахнись он, и наши
// двадцать строк с Enter уехали бы в рамку, то есть выбрали бы в ней ответ за человека.
test('запрос разрешения держит и без найденной на экране рамки', () => {
  const perm = { status: 'waiting', kind: 'permission', dialog: false };
  assert.strictEqual(step(idle(), perm).action, 'nothing');
  const granted = { ...idle(), phase: 'granted', at: NOW - 1000, prompt: 'дальше' };
  assert.strictEqual(R.step(granted, sig({ hasLine: true, ...perm })).action, 'nothing');
  // А зов — не рамка: он проходит.
  assert.strictEqual(step(idle(), { status: 'waiting', kind: 'question' }).action, 'ask');
});

// Та же дыра, но с той стороны, где она опаснее всего. Коробка AskUserQuestion приходит тем же
// `kind: 'question'`, что и обычный зов прозой, — а Enter она съедает так же, как запрос
// разрешения. От неё оставался один скрёб экрана, и его промах (рамка уехала за край, чужая
// отрисовка) означал двадцать строк просьбы и Enter В КОРОБКУ: выбор в ней сделали бы за человека.
// Различает их только `box` — рамку Клод объявляет событием, а зов виден лишь как конец хода.
test('коробка вопроса держит так же, как запрос разрешения', () => {
  const boxed = { status: 'waiting', kind: 'question', box: true, dialog: false };
  assert.strictEqual(step(idle(), boxed).action, 'nothing', 'в коробку не печатаем просьбу');
  const granted = { ...idle(), phase: 'granted', at: NOW - 1000, prompt: 'дальше' };
  assert.strictEqual(R.step(granted, sig({ hasLine: true, ...boxed })).action, 'nothing',
    'и /exit в коробку тоже не печатаем');
  // Разрешение при этом не выбрасываем: коробку закроют, и вкладка снова станет подходящей.
  assert.strictEqual(R.step(granted, sig({ hasLine: true, ...boxed })).state.phase, 'granted');
  // А тот же зов без коробки по-прежнему проходит — иначе вкладки сворма, которые прощаются
  // зовом всегда, не перезапускались бы никогда.
  const call = { status: 'waiting', kind: 'question', box: false, dialog: false };
  assert.strictEqual(step(idle(), call).action, 'ask');
  assert.strictEqual(R.step(granted, sig({ hasLine: true, ...call })).action, 'exit');
});

// Ревью, проход 6: срок стоял только на ожидание строки запуска, а дальше фаза ждала покоя сколько
// угодно. Агент мог написать ответ инструментом посреди хода и работать ещё три часа — и мы гасили
// вкладку в первый спокойный миг, стартуя свежую сессию с ночным промптом и запиской, которая давно
// не про неё. Всё сделанное за эти часы уходило без эстафеты вообще.
test('разрешение целиком портится, а не только пока ждём строку', () => {
  const granted = { ...idle(), phase: 'granted', at: NOW - R.GRANT_CALM_MS - 1, prompt: 'дальше' };
  const r = R.step(granted, sig({ hasLine: true }));
  assert.strictEqual(r.action, 'drop');
  assert.strictEqual(r.state.phase, 'idle');
  assert.ok(r.note.includes('устарело'));
  // А вовремя — исполняется.
  const fresh = { ...granted, at: NOW - 1000 };
  assert.strictEqual(R.step(fresh, sig({ hasLine: true })).action, 'exit');
});

// Ревью, проход 6: у срока переспроса был потолок, но не было пола. «Спроси через минуту» от агента,
// занятого длинной работой, означало двадцать строк просьбы каждую минуту всю ночь.
test('срок переспроса зажат с двух сторон', () => {
  assert.strictEqual(R.parseAnswer('{"restart":false,"retry":1}').retryMs, R.RETRY_MIN_MS);
  assert.strictEqual(R.parseAnswer('{"restart":false,"retry":25}').retryMs, 25 * 60 * 1000);
  assert.strictEqual(R.parseAnswer('{"restart":false,"retry":1440}').retryMs, 3 * HOUR);
});

// Ревью, проход 6: на Windows `ps` недоступен, shellBusy всегда undefined — и проверка «агент в
// оболочке есть» не срабатывала вовсе. Человек закрыл Клода руками, а мы через двадцать минут
// отправляли двадцать строк русской прозы в cmd.exe на исполнение.
test('без ps судим по экрану: нет мебели Клода — нет и просьбы', () => {
  assert.strictEqual(step(idle(), { shellBusy: undefined, modeVisible: false }).action, 'nothing');
  assert.strictEqual(step(idle(), { shellBusy: undefined, modeVisible: true }).action, 'ask');
});

test('без строки запуска гасить нечем, но и ждать её не вечно', () => {
  const granted = { ...idle(), phase: 'granted', at: NOW - 1000, prompt: 'дальше' };
  assert.strictEqual(R.step(granted, sig()).action, 'nothing');
  const old = { ...granted, at: NOW - R.GRANT_WAIT_MS - 1 };
  const r = R.step(old, sig());
  assert.strictEqual(r.action, 'drop');
  assert.strictEqual(r.state.phase, 'idle');
  assert.ok(r.state.retryAt > NOW, 'и с отсрочкой, иначе следующий тик придёт через полминуты');
});

// Ревью, проход 7: проверка «агент в оболочке есть» стояла только у просьбы, а гасит `/exit`
// больше. За время ожидания покоя человек мог закрыть Клода и запустить в той же оболочке npm test —
// и наш `/exit` с Enter уезжал туда.
test('гасить тоже нельзя, если агента в оболочке уже нет', () => {
  const granted = { ...idle(), phase: 'granted', at: NOW - 1000, prompt: 'дальше' };
  assert.strictEqual(R.step(granted, sig({ hasLine: true, shellBusy: false })).action, 'nothing');
  assert.strictEqual(
    R.step(granted, sig({ hasLine: true, shellBusy: undefined, modeVisible: false })).action,
    'nothing',
  );
  assert.strictEqual(R.step(granted, sig({ hasLine: true })).action, 'exit');
});

// Ревью, проход 7: у просроченного разрешения не было потолка. Агент, который разрешает и уходит
// работать дольше срока годности, вежлив, но результат тот же: круг каждые полчаса всю ночь.
test('разрешил и не дождались — тоже считается молчанием, с тем же потолком', () => {
  let st = { ...idle(), phase: 'granted', at: NOW - R.GRANT_CALM_MS - 1, prompt: 'дальше' };
  for (let i = 1; i < R.MAX_SILENT; i++) {
    const r = R.step(st, sig({ hasLine: true }));
    assert.strictEqual(r.state.phase, 'idle');
    assert.strictEqual(r.state.silent, i);
    st = { ...r.state, phase: 'granted', at: NOW - R.GRANT_CALM_MS - 1, prompt: 'дальше' };
  }
  const last = R.step(st, sig({ hasLine: true }));
  assert.strictEqual(last.state.phase, 'muted');
  assert.ok(last.note.includes('больше не спрашиваю'));
});

// Ревью, проход 2: отмена и выход агента расходятся во времени. /exit уже в очереди, отменить его
// нельзя — поэтому строка ждёт освободившейся оболочки, иначе вкладка останется голым шеллом.
test('вышел агент — печатаем запуск', () => {
  const exiting = { ...idle(), phase: 'exiting', exitAt: NOW - 5000 };
  const r = R.step(exiting, sig({ shellBusy: false }));
  assert.strictEqual(r.action, 'fire');
  assert.strictEqual(r.state.phase, 'idle');
});

test('агент на месте — ждём, но не дольше часа и только пока он жив', () => {
  const exiting = { ...idle(), phase: 'exiting', exitAt: NOW - 5000 };
  assert.strictEqual(R.step(exiting, sig()).action, 'nothing');
  const stuck = { ...idle(), phase: 'exiting', exitAt: NOW - R.PENDING_MS - 1 };
  const r = R.step(stuck, sig());
  assert.strictEqual(r.action, 'drop');
  assert.ok(r.note.includes('не вышел'));
  // А если оболочка при этом ПУСТА — печатаем, а не отменяем: иначе вкладка без агента.
  assert.strictEqual(R.step(stuck, sig({ shellBusy: false })).action, 'fire');
});

// Ревью правки про закрытие сигналом: короткий срок ожидания здесь пробовали и убрали. Он
// создавал гонку — отменяем перезапуск, стирая заготовку, а агент дозакрывается секундой позже,
// и вкладка остаётся голой оболочкой навсегда: спрашивать больше не у кого, печатать нечем.
test('срок ожидания ухода один, каким бы способом ни просили', () => {
  const st = (age) => ({ ...idle(), phase: 'exiting', exitAt: NOW - age });
  assert.strictEqual(R.step(st(60_000), sig()).action, 'nothing');
  assert.strictEqual(R.step(st(R.PENDING_MS - 1), sig()).action, 'nothing');
  assert.strictEqual(R.step(st(R.PENDING_MS + 1), sig()).action, 'drop');
});

// Ревью, проход 2 и 4: снятая галочка не должна бросать вкладку между /exit и запуском.
test('выключенная функция не бросает начатый перезапуск', () => {
  const exiting = { ...idle(), phase: 'exiting', exitAt: NOW - 5000 };
  assert.strictEqual(R.step(exiting, sig({ enabled: false, shellBusy: false })).action, 'fire');
});

// --- уход агента по экрану (Windows, где `ps` недоступен) ----------------------
// Ревью, проход 4: /exit сам открывает меню команд Клода, и оно закрывает строку режима — то есть
// «мебели нет» в первый же миг после набора. Без выдержки мы печатали запуск живому агенту.
test('экранный путь: выдержка после /exit', () => {
  const st = { ...idle(), phase: 'exiting', exitAt: NOW };
  const early = R.step(st, sig({ shellBusy: undefined, modeVisible: false, now: NOW + 1000 }));
  assert.strictEqual(early.action, 'nothing');
});

// Ревью, проход 5: два опроса подряд по одному и тому же кадру давали «дважды видели» на одной
// случайной перерисовке. Второе подтверждение должно быть отделено временем.
test('экранный путь: два подтверждения врозь, а не два вызова', () => {
  const after = NOW + R.EXIT_BLIND_MS + 1;
  const st = { ...idle(), phase: 'exiting', exitAt: NOW };
  const first = R.step(st, sig({ shellBusy: undefined, modeVisible: false, now: after }));
  assert.strictEqual(first.action, 'nothing', 'первый взгляд ничего не решает');
  const same = R.step(first.state, sig({ shellBusy: undefined, modeVisible: false, now: after }));
  assert.strictEqual(same.action, 'nothing', 'тот же кадр вторым подтверждением не считается');
  const later = R.step(first.state, sig({
    shellBusy: undefined, modeVisible: false, now: after + R.GONE_GAP_MS + 1,
  }));
  assert.strictEqual(later.action, 'fire');
});

test('экранный путь: вернувшаяся мебель сбрасывает счёт', () => {
  const after = NOW + R.EXIT_BLIND_MS + 1;
  const st = { ...idle(), phase: 'exiting', exitAt: NOW, goneSeen: after };
  const back = R.step(st, sig({ shellBusy: undefined, modeVisible: true, now: after + 2000 }));
  assert.strictEqual(back.action, 'nothing');
  assert.strictEqual(back.state.goneSeen, 0);
});

// Диалог на экране — «агент на месте» при любых других признаках: строки режима при нём тоже нет,
// и принять это за уход означало бы напечатать запуск в рамку запроса.
test('диалог на экране не считается уходом агента', () => {
  const after = NOW + R.EXIT_BLIND_MS + 1;
  const st = { ...idle(), phase: 'exiting', exitAt: NOW, goneSeen: NOW };
  const r = R.step(st, sig({ shellBusy: undefined, modeVisible: false, dialog: true, now: after }));
  assert.strictEqual(r.action, 'nothing');
  assert.strictEqual(r.state.goneSeen, 0);
});

test('разбираем ответ в заборчике и с текстом вокруг', () => {
  const raw = 'Хорошо, вот:\n```json\n{"restart": true, "prompt": "продолжи таск 215",'
    + ' "handoff": "#215"}\n```\nготово';
  const a = R.parseAnswer(raw);
  assert.strictEqual(a.restart, true);
  assert.strictEqual(a.prompt, 'продолжи таск 215');
  assert.strictEqual(a.handoff, '#215');
});

test('эстафета текстом — тоже разрешение', () => {
  const a = R.parseAnswer('{"restart":true,"prompt":"читай эстафету","text":"сделано A, дальше B"}');
  assert.strictEqual(a.restart, true);
  assert.strictEqual(a.text, 'сделано A, дальше B');
});

// «Можно» без промпта или без эстафеты — полразрешения. Перезапустить и не сказать свежей
// сессии, что делать, хуже, чем не перезапускать вовсе.
test('«можно» без промпта не перезапускает', () => {
  const a = R.parseAnswer('{"restart":true,"handoff":"#215"}');
  assert.strictEqual(a.restart, false);
  assert.strictEqual(a.reason, 'no-prompt');
  assert.ok(a.retryMs > 0);
});

test('«можно» без эстафеты не перезапускает', () => {
  const a = R.parseAnswer('{"restart":true,"prompt":"продолжай"}');
  assert.strictEqual(a.restart, false);
  assert.strictEqual(a.reason, 'no-handoff');
});

test('«не сейчас» несёт срок переспроса', () => {
  assert.strictEqual(R.parseAnswer('{"restart":false,"retry":25}').retryMs, 25 * 60 * 1000);
  // Без срока — умолчание, а не «никогда».
  assert.strictEqual(R.parseAnswer('{"restart":false}').retryMs, R.RETRY_MS);
  // «Через сутки» — это отказ, а не отсрочка: потолок три часа.
  assert.strictEqual(R.parseAnswer('{"restart":false,"retry":1440}').retryMs, 3 * HOUR);
  assert.strictEqual(R.parseAnswer('{"restart":false,"retry":-5}').retryMs, R.RETRY_MS);
});

test('мусор вместо ответа — null, а не догадка', () => {
  assert.strictEqual(R.parseAnswer(''), null);
  assert.strictEqual(R.parseAnswer('можно, перезапускай'), null);
  assert.strictEqual(R.parseAnswer('{сломанный json'), null);
  assert.strictEqual(R.parseAnswer(null), null);
});

// Эстафета приходит оттуда, куда пишет не только наш агент (комментарий в чужом таске).
// Поэтому текст от агента становится ОДНИМ аргументом, а не строкой для шелла.
test('промпт уезжает одним аргументом, шелл в него не влезает', () => {
  const line = R.launchLine('claude -n swarm-ab12', 'продолжи; rm -rf ~ && echo `whoami`', 'posix');
  assert.strictEqual(line, "claude -n swarm-ab12 'продолжи; rm -rf ~ && echo `whoami`'");
  assert.ok(!/^[^']*&&/.test(line), 'команда не должна распадаться на две');
});

test('кавычка в промпте не разрывает аргумент', () => {
  assert.strictEqual(R.launchLine('claude', "файл 'a.js'", 'posix'), "claude 'файл '\\''a.js'\\'''");
});

test('перевод строки в промпте не превращается в Enter', () => {
  const line = R.launchLine('claude', 'первая строка\nвторая строка', 'posix');
  assert.ok(!line.includes('\n'), 'иначе половина промпта уедет в шелл отдельной командой');
  assert.strictEqual(line, "claude 'первая строка вторая строка'");
});

// Кавычки по семейству оболочки. На cmd.exe одинарная не значит ничего: `claude 'таск 215'`
// доедет до Клода тремя аргументами вместо одного, и промпт превратится в мусор.
test('cmd.exe получает двойные кавычки, а не одинарные', () => {
  const line = R.launchLine('claude', 'продолжи таск 215', 'cmd');
  assert.strictEqual(line, 'claude "продолжи таск 215"');
  // Внутренняя кавычка удваивается, а %VAR% не должно раскрыться внутри кавычек.
  assert.strictEqual(R.quoteArg('файл "a.js" и %PATH%', 'cmd'), '"файл ""a.js"" и  PATH "');
});

test('powershell — одинарные с удвоением, обратный слэш там не экранирует', () => {
  assert.strictEqual(R.quoteArg("файл 'a.js'", 'powershell'), "'файл ''a.js'''");
});

// Незнакомая оболочка (nushell, xonsh, что-то своё в $SHELL): синтаксис экранирования нам
// неизвестен, гадать нельзя. Двойные кавычки понимают все, а особые знаки из промпта убираем —
// кусок формулировки дешевле сломанной команды.
test('незнакомая оболочка — двойные кавычки и никаких особых знаков внутри', () => {
  assert.strictEqual(R.quoteArg("файл 'a.js'", null), '"файл \'a.js\'"');
  const risky = R.quoteArg('эхо `whoami` и $HOME и "кавычка" и \\слэш', null);
  assert.ok(!/[`$"\\]/.test(risky.slice(1, -1)), 'внутри кавычек не должно остаться особых знаков');
  assert.ok(risky.startsWith('"') && risky.endsWith('"'));
});

test('пустой промпт — просто команда, без пустых кавычек', () => {
  assert.strictEqual(R.launchLine('claude -n swarm-1', '', 'posix'), 'claude -n swarm-1');
  assert.strictEqual(R.launchLine('', 'что-то', 'posix'), '');
});

// Промпт печатается в оболочку вкладки, и на килобайтах это вешало приложение целиком
// (BUG-pty-deadlock-2026-08-11.md). Длинный промпт — это эстафета, приехавшая не тем полем:
// её место в файле, а в терминале — указатель.
test('короткий промпт печатаем, длинный уносим в записку', () => {
  assert.ok(R.promptFits('продолжи таск 215'));
  assert.ok(R.promptFits(''));
  assert.ok(R.promptFits('я'.repeat(R.PROMPT_MAX)), 'ровно потолок ещё влезает');
  assert.ok(!R.promptFits('я'.repeat(R.PROMPT_MAX + 1)));
  // Тот самый случай: пересказ состояния работы на несколько килобайт.
  assert.ok(!R.promptFits('ворктри ../fastio-506, критерии приёмки, что дальше. '.repeat(40)));
});

test('указатель на записку приклеивается к промпту одной точкой', () => {
  assert.strictEqual(
    R.handoffPrompt('продолжи таск 215', '/p/.swarm-handoff-tab-2.md'),
    'продолжи таск 215. Эстафета лежит в /p/.swarm-handoff-tab-2.md — прочитай её первым делом.');
  // Агент кончает промпт точкой — второй быть не должно.
  assert.ok(R.handoffPrompt('продолжай.', '/p/h.md').startsWith('продолжай. Эстафета'));
  assert.ok(R.handoffPrompt('продолжай!  ', '/p/h.md').startsWith('продолжай. Эстафета'));
  // Промпта не осталось вовсе — фраза не должна начинаться с точки.
  assert.strictEqual(R.handoffPrompt('', '/p/h.md'),
    'Эстафета лежит в /p/h.md — прочитай её первым делом.');
  assert.strictEqual(R.handoffPrompt('...', '/p/h.md'),
    'Эстафета лежит в /p/h.md — прочитай её первым делом.');
});

test('промпт для унесённой эстафеты сам себя не описывает как задачу', () => {
  // Задачи в нём нет и быть не может: она в записке, и указатель допишет handoffPrompt.
  assert.ok(R.promptFits(R.PROMPT_CARRIED));
  assert.ok(R.PROMPT_CARRIED.trim().length > 0);
  assert.ok(!/эстафет/i.test(R.PROMPT_CARRIED), 'про записку говорит handoffPrompt, а не он');
});

test('в просьбе есть и путь ответа, и процент, и все поля', () => {
  const t = R.askText({ pct: 31, answerFile: '/tmp/swarm/answer.json' });
  assert.ok(t.includes('/tmp/swarm/answer.json'));
  assert.ok(t.includes('31%'));
  for (const key of ['restart', 'retry', 'handoff', 'text', 'prompt']) {
    assert.ok(t.includes(key), `в просьбе не описано поле ${key}`);
  }
});

// Хвосты разговора: записка о работе их не ловит — «что сделано» и «на чём стоишь» про
// репозиторий, а эти два про людей. Незаданный вопрос умрёт вместе с разговором (зов перезапуску
// больше не помеха, см. turnOver), а отложенное «доделаем и обсудим» не ловится ничем в принципе:
// в коде его нет, в задаче нет, живёт оно только в переписке. Спасти может лишь сам агент.
// Записка умирает вместе со вкладкой, а знание о задаче — развилки, отвергнутые варианты, грабли
// — должно её пережить. Формат не диктуем: куда это класть, знает процесс команды, а не мы.
// Главное здесь — «дописывай, а не переписывай»: за три круга перезапись съедает всё.
test('в просьбе велено сохранить наработки по процессу и дописывать', () => {
  const t = R.askText({ pct: 31, answerFile: '/tmp/a.json' });
  assert.ok(/предусмотрено твоим процессом/.test(t), 'формат — дело процесса, не наше');
  assert.ok(/Дописывай, а не переписывай/.test(t));
  assert.ok(/отвергнутые варианты/.test(t) && /развилки/.test(t));
});

test('в просьбе сказано про оба хвоста разговора', () => {
  const t = R.askText({ pct: 31, answerFile: '/tmp/a.json' });
  assert.ok(/спросил человека/.test(t) && /впиши вопрос в записку/.test(t), 'незаданный вопрос');
  assert.ok(/договорились вернуться/.test(t) && /обсудим/.test(t), 'отложенный разговор');
});

// --- прозу вместо файла не читаем — и явно об этом говорим ------------------------------------
// Живой случай: агент отвечает в чат словами («да, можно» / «не сейчас»), файла не кладёт, и
// автомат честно засчитывает это молчанием. Раньше просьба не говорила прямо, что текст здесь не
// считается за ответ, — агент разумно предполагал обратное (тем же способом читаются теги
// [swarm:вопрос]/[swarm:фон] в других частях протокола).
test('в просьбе прямо сказано: текстом здесь не отвечать, только файлом', () => {
  const t = R.askText({ pct: 31, answerFile: '/tmp/a.json' });
  assert.ok(/только файл/.test(t), 'явный запрет на прозу');
  assert.ok(/не увижу|не пойму как ответ/.test(t));
});

// --- переспрос после молчания — короткий, не полный askText --------------------------------
// Три полных askText подряд (MAX_SILENT), пока агент отвечает не туда, куда читает автомат, — это
// и есть тот расход контекста, ради экономии которого весь перезапуск затевался (живой случай:
// вкладка дошла до 70% такими кругами). Переспрос обязан быть короче исходной просьбы и напоминать
// именно про форму ответа, а не пересказывать все критерии заново.
test('переспрос после молчания короче исходной просьбы и указывает на файл', () => {
  const full = R.askText({ pct: 55, answerFile: '/tmp/a.json' });
  const again = R.askAgainText({ pct: 55, answerFile: '/tmp/a.json' });
  assert.ok(again.length < full.length / 3, 'переспрос заметно короче полной просьбы');
  assert.ok(again.includes('/tmp/a.json'));
  assert.ok(again.includes('55%'));
  assert.ok(/только файл/.test(again));
});

// --- «работа здесь закончена» ---------------------------------------------------------------
// Ответов было два: «можно» и «не сейчас, переспроси через N». Законченную работу приходилось
// выражать вторым — то есть вечным кругом: сворм переспрашивает, агент снова говорит «не сейчас»,
// и так до закрытия вкладки. Причём просьба права: перезапускать доделанную вкладку НЕЛЬЗЯ,
// свежая сессия получит «продолжи» на готовое и пойдёт искать несуществующий остаток. Значит
// нужен третий ответ — «спрашивать больше не о чем», без срока.
test('«закончено» разбирается отдельно от отсрочки', () => {
  const a = R.parseAnswer('{"restart":false,"done":true}');
  assert.strictEqual(a.restart, false);
  assert.strictEqual(a.done, true);
  assert.strictEqual(a.reason, 'done');
  // Обычный отказ остаётся отказом со сроком — «закончено» не должно поглотить его.
  assert.ok(!R.parseAnswer('{"restart":false,"retry":25}').done);
});

test('«можно» вместе с «закончено» — перезапуск главнее, если разрешение полное', () => {
  const a = R.parseAnswer('{"restart":true,"done":true,"prompt":"дальше","handoff":"#215"}');
  assert.strictEqual(a.restart, true, 'разрешение с эстафетой исполняем, а не молчим');
});

// Живой случай (fastio, 2026-08-30/31, восстановлен по restart.log и транскрипту сессии):
// агент 16 раз подряд за 5+ часов писал ровно {"restart":true,"done":true} без prompt —
// считал done пометкой «эта задача закончена», а не «продолжать нечем». До фикса это било в
// no-prompt и звало агента на тот же вопрос заново каждые двадцать минут, никогда не объясняя
// почему. Раз полного «можно» нет (нет prompt/эстафеты), а done есть — это и значит «спрашивать
// больше не о чем», а не «отсрочка».
test('«можно» без промпта вместе с «закончено» — закончено побеждает, а не no-prompt', () => {
  const a = R.parseAnswer('{"restart":true,"done":true}');
  assert.strictEqual(a.restart, false);
  assert.strictEqual(a.done, true);
  assert.strictEqual(a.reason, 'done');
});

test('ответ «закончено» уводит в немоту без переспроса', () => {
  const asked = { ...idle(), phase: 'asked', askedAt: NOW - 1000 };
  const r = R.step(asked, sig({ answer: { raw: '{"restart":false,"done":true}', mtime: NOW } }));
  assert.strictEqual(r.action, 'drop', 'ответ прочитан — файл убираем');
  assert.strictEqual(r.state.phase, 'done');
  assert.strictEqual(r.state.retryAt, 0, 'никаких сроков: переспрашивать не о чем');
  assert.ok(/закончена/.test(r.note || ''), 'человеку видно, почему вкладка замолчала');
});

test('то же самое из отсрочки: агент вправе сказать «всё» раньше срока', () => {
  const later = { ...idle(), retryAt: NOW + 20 * 60 * 1000 };
  const r = R.step(later, sig({ answer: { raw: '{"restart":false,"done":true}', mtime: NOW } }));
  assert.strictEqual(r.state.phase, 'done');
  assert.strictEqual(r.state.retryAt, 0);
});

test('в фазе done не спрашиваем, но положенный файл читаем и исполняем', () => {
  const done = { ...idle(), phase: 'done' };
  assert.strictEqual(R.step(done, sig()).action, 'nothing', 'просьба больше не печатается');
  assert.strictEqual(R.wantsAnswer(done, { enabled: true }), true, 'а файл читать не перестаём');
  // Человек дал вкладке новую работу, агент сам позвал перезапуск — молчание этому не помеха.
  const raw = '{"restart":true,"prompt":"дальше","handoff":"#215"}';
  const r = R.step(done, sig({ answer: { raw, mtime: NOW } }));
  assert.strictEqual(r.action, 'grant');
  assert.strictEqual(r.state.phase, 'granted');
});

for (const [name, fn] of tests) {
  try { fn(); passed++; } catch (e) {
    console.error(`FAIL ${name}\n  ${e.message}`);
    process.exit(1);
  }
}
console.log(`restart: ${passed}/${tests.length} ok`);
