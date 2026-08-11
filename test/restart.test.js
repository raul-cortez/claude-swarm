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
const OPTS = { enabled: true, threshold: 30, now: 1000 + HOUR };

test('порог зажат диапазоном 15–75', () => {
  assert.strictEqual(R.clampPct(0), 15);
  assert.strictEqual(R.clampPct(14), 15);
  assert.strictEqual(R.clampPct(30), 30);
  assert.strictEqual(R.clampPct(76), 75);
  assert.strictEqual(R.clampPct(1000), 75);
  assert.strictEqual(R.clampPct('нет'), R.DEFAULT_PCT);
  assert.strictEqual(R.clampPct(undefined), R.DEFAULT_PCT);
});

// Сюда приходит localStorage.getItem, а он на несохранённой настройке даёт null. Через
// Number(null) это ноль, то есть 15% — самый частый перезапуск, и молча: 15 законное значение.
// Новый человек получал бы вдвое чаще обещанного, не тронув ползунок.
test('незаданный порог — это умолчание, а не ноль', () => {
  assert.strictEqual(R.clampPct(null), R.DEFAULT_PCT);
  assert.strictEqual(R.clampPct(''), R.DEFAULT_PCT);
  // А вот строка с числом — настоящая настройка, её уважаем.
  assert.strictEqual(R.clampPct('45'), 45);
  assert.strictEqual(R.clampPct('0'), 15);
});

// --- автомат ------------------------------------------------------------------
// Пять проходов ревью нашли 38 замечаний, и 35 из них — в main.js, где эти же решения лежали
// вразброс. Здесь каждый найденный сценарий стал проверкой: «ревью нашло путь X» превращается в
// «тест покрывает путь X».
const NOW = 10 * HOUR;
// Вкладка, которую спрашивать МОЖНО: контекст за порогом, покой, агент на месте, отработала час.
function sig(over) {
  return {
    now: NOW, enabled: true, threshold: 30, pct: 40, status: 'ready',
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
  assert.strictEqual(step(idle(), { pct: 40, threshold: 75 }).action, 'nothing');
  assert.strictEqual(R.step({ ...idle(), phase: 'muted' }, sig()).action, 'nothing');
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

for (const [name, fn] of tests) {
  try { fn(); passed++; } catch (e) {
    console.error(`FAIL ${name}\n  ${e.message}`);
    process.exit(1);
  }
}
console.log(`restart: ${passed}/${tests.length} ok`);
