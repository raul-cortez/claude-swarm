// Ночной режим: решения (толкать / спросить / оставить стоять) и тексты, которые едут агенту.
// Чистый Node — как и весь night.js, который для этого и отделён от main.js: проверить это в
// живом приложении можно только дождавшись ночи.
//
// Здесь же сверяются ДУБЛИКАТЫ, живущие в hooks/swarm-signal.mjs: хук — отдельный процесс без
// доступа к модулям приложения, и разъехавшееся ночное правило значит, что агент получает
// разные инструкции в зависимости от того, КАК он спросил.
const assert = require('assert');
const night = require('../night');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const NOW = 1_700_000_000_000;
const OLD = NOW - 60 * 60_000;        // вкладка живёт час: прогрев давно прошёл

function waitCtx(over) {
  return Object.assign({
    auto: true, kind: 'question', box: false,
    now: NOW, bootAt: OLD, startedAt: OLD, fingerprint: 'мигрировать ли старый формат',
  }, over || {});
}

function readyCtx(over) {
  return Object.assign({
    auto: true, status: 'ready', bg: false, limited: false,
    now: NOW, bootAt: OLD, startedAt: OLD, readyAt: NOW - night.IDLE_MS - 1000,
    // Вкладка при нас поработала и замолчала — иначе спрашивать её не о чем.
    workedAt: NOW - night.IDLE_MS - 1000, turn: OLD,
  }, over || {});
}

// --- толчок в ждущую вкладку --------------------------------------------------

test('вопрос прозой ночью получает толчок', () => {
  const d = night.nudgeDecision({}, waitCtx());
  assert.strictEqual(d.act, 'nudge');
});

// Решает не положение всего приложения, а МАНДАТ ЭТОЙ ВКЛАДКИ: человек может сидеть рядом и
// всё равно сказать «эту делай сам», и наоборот — уйти, оставив одну вкладку себе.
test('вкладку без мандата не трогают вовсе', () => {
  for (const c of [{ auto: false }, { auto: undefined }]) {
    const d1 = night.nudgeDecision({}, waitCtx(c));
    const d2 = night.phaseDecision({}, readyCtx(c));
    assert.strictEqual(d1.act, 'skip');
    assert.match(d1.why, /не в ночном режиме/);
    assert.strictEqual(d2.act, 'skip');
    assert.match(d2.why, /не в ночном режиме/);
  }
});

test('запрос разрешения стоит до утра, а не толкается', () => {
  const d = night.nudgeDecision({}, waitCtx({ kind: 'permission' }));
  assert.strictEqual(d.act, 'stand');
  assert.match(d.why, /разрешение/);
});

// Печать в открытую рамку уходит ВЫБОРОМ ВАРИАНТА, а не текстом: Enter там принадлежит
// диалогу. Это не косметика — толчок в рамку выбирает за агента случайный пункт.
test('в открытую рамку не печатаем', () => {
  assert.strictEqual(night.nudgeDecision({}, waitCtx({ box: true })).act, 'skip');
});

test('свежую вкладку не трогаем: она перерисовывает вчерашний вопрос', () => {
  const d = night.nudgeDecision({}, waitCtx({ startedAt: NOW - 1000 }));
  assert.strictEqual(d.act, 'skip');
  assert.match(d.why, /только открылась/);
});

test('без текста вопроса толкать нечем', () => {
  assert.strictEqual(night.nudgeDecision({}, waitCtx({ fingerprint: '' })).act, 'skip');
});

// Главный предохранитель ночи: без него сворм и агент вежливо переписываются до утра и жгут
// токены на пустой диалог.
test('тем же вопросом второй раз не толкаем — вкладка стоит', () => {
  const st = { nudges: 1, nudgedKeys: ['мигрировать ли старый формат'] };
  const d = night.nudgeDecision(st, waitCtx());
  assert.strictEqual(d.act, 'stand');
  assert.match(d.why, /второй раз/);
});

// И НОВЫЙ вопрос после правила — тоже не толчок. Раньше он им был («новое событие»), и из
// этого выходил круг: правило — новый вопрос — правило, всю ночь в одну вкладку. Агент,
// услышавший правило и всё равно вставший с вопросом, тем и сказал, что вопрос настоящий.
test('после правила вкладка стоит даже с новым вопросом', () => {
  const st = { nudges: 1, nudgedKeys: ['совсем другой вопрос'] };
  const d = night.nudgeDecision(st, waitCtx());
  assert.strictEqual(d.act, 'stand');
  assert.match(d.why, /уже слышала/);
});

test('правило звучит один раз за ночь', () => {
  assert.strictEqual(night.MAX_NUDGES, 1);
  const d = night.nudgeDecision({ nudges: night.MAX_NUDGES, nudgedKeys: [] }, waitCtx());
  assert.strictEqual(d.act, 'stand');
});

// Третьим вариантом ночного вопроса про фазу агенту ПРЕДЛОЖЕНО спросить и ждать утра. Толчок
// правилом в такой вопрос — спор с собственным разрешением, и снова круг.
test('вопрос после ночного разговора про фазу не толкаем', () => {
  const d = night.nudgeDecision({ asks: 1 }, waitCtx());
  assert.strictEqual(d.act, 'stand');
  assert.match(d.why, /ждать до утра/);
});

// Полминуты после запуска приложения экран врёт: вкладки перерисовывают вчерашнюю переписку.
test('сразу после запуска приложения ночь молчит', () => {
  const boot = NOW - 5_000;
  assert.strictEqual(night.nudgeDecision({}, waitCtx({ bootAt: boot })).act, 'skip');
  const d = night.phaseDecision({}, readyCtx({ bootAt: boot }));
  assert.strictEqual(d.act, 'skip');
  assert.match(d.why, /только запустилось/);
});

// --- вопрос про порог фазы ----------------------------------------------------

test('вкладка простояла две минуты — спрашиваем про порог фазы', () => {
  assert.strictEqual(night.phaseDecision({}, readyCtx()).act, 'ask');
});

test('минуту простоя не считаем простоем', () => {
  const d = night.phaseDecision({}, readyCtx({ readyAt: NOW - 60_000 }));
  assert.strictEqual(d.act, 'skip');
  assert.match(d.why, /двух минут/);
});

// Главный промах ночи, каким её увидели живьём: обновил сворм, все вкладки простаивают — и
// через две минуты ночь пишет в КАЖДУЮ, хотя ни одна ничего не начинала. Простой сам по себе не
// новость; новость — кончившийся ход.
test('вкладку, которая при нас не работала, не спрашиваем', () => {
  const d = night.phaseDecision({}, readyCtx({ workedAt: 0 }));
  assert.strictEqual(d.act, 'skip');
  assert.match(d.why, /не работала/);
});

test('ход, кончившийся до запуска приложения, за работу не считаем', () => {
  const boot = NOW - 10 * 60_000;
  const d = night.phaseDecision({}, readyCtx({ bootAt: boot, workedAt: boot + 1000 }));
  assert.strictEqual(d.act, 'skip');
  assert.match(d.why, /до запуска/);
});

// Второй круг того же промаха: вкладка ответила «всё сделано», замолчала — и через две минуты
// получила тот же вопрос снова. Ответ нам работой не считается: он и есть та самая тишина.
test('ответившую на прошлый вопрос не спрашиваем второй раз', () => {
  const st = { resolvedAt: NOW - 5 * 60_000 };
  const d = night.phaseDecision(st, readyCtx({ workedAt: NOW - 6 * 60_000 }));
  assert.strictEqual(d.act, 'skip');
  assert.match(d.why, /не работала/);
  // А вкладка, которая после разбора закрыла ещё один ход, — заслуживает: это новая фаза.
  assert.strictEqual(night.phaseDecision(st, readyCtx({ workedAt: NOW - 3 * 60_000 })).act, 'ask');
});

// «Сейчас от тебя: ничего, жду замер стенда» — агент не простаивает, он ждёт свою фоновую
// задачу, и она его разбудит. Вопрос сюда — перебивание.
test('ждущего фоновую задачу не перебиваем', () => {
  assert.strictEqual(night.phaseDecision({}, readyCtx({ bg: true })).act, 'skip');
});

test('стоящую на лимите не спрашиваем: её разбудит будильник', () => {
  assert.strictEqual(night.phaseDecision({}, readyCtx({ limited: true })).act, 'skip');
});

test('работающую вкладку не трогаем', () => {
  assert.strictEqual(night.phaseDecision({}, readyCtx({ status: 'running' })).act, 'skip');
});

test('про один и тот же ход спрашиваем один раз', () => {
  const st = { askedTurn: OLD };
  assert.strictEqual(night.phaseDecision(st, readyCtx({ turn: OLD })).act, 'skip');
  assert.strictEqual(night.phaseDecision(st, readyCtx({ turn: OLD + 1 })).act, 'ask');
});

// Вкладка наш вопрос проигнорировала: из «готова» она не выходила, простой тот же самый.
// Спрашивать второй раз незачем — а без этой проверки вопрос повторялся бы каждые две минуты.
test('тот же простой второго вопроса не заслуживает', () => {
  const st = { askedAt: NOW - 5 * 60_000 };
  const d = night.phaseDecision(st, readyCtx({ readyAt: NOW - 10 * 60_000 }));
  assert.strictEqual(d.act, 'skip');
  assert.match(d.why, /простой тот же/);
  // А НОВЫЙ простой (вкладка поработала и снова замолчала) — заслуживает: иначе вкладка,
  // закрывшая очередной шаг, теряет остаток ночи.
  assert.strictEqual(night.phaseDecision(st, readyCtx({ readyAt: NOW - 3 * 60_000 })).act, 'ask');
});

// Отличить «закончил всю работу» от «закончил очередной шаг» по взгляду на статус нельзя: и то
// и другое — молчащая зелёная вкладка. Поэтому запирающей отметки нет, есть потолок.
test('потолок вопросов за ночь оставляет вкладку в покое', () => {
  const d = night.phaseDecision({ asks: night.MAX_ASKS }, readyCtx());
  assert.strictEqual(d.act, 'stand');
  assert.match(d.why, /потолок вопросов/);
});

test('потолок продолжений за ночь оставляет вкладку стоять', () => {
  const d = night.phaseDecision({ continues: night.MAX_CONTINUES }, readyCtx());
  assert.strictEqual(d.act, 'stand');
  assert.match(d.why, /потолок/);
});

// --- тексты -------------------------------------------------------------------

test('правило называет тег и место, с которого он считается', () => {
  const r = night.rule('[swarm:вопрос]');
  assert.ok(r.includes('отдельной строкой с тегом [swarm:вопрос]'), r);
  // Пустая метка не должна оставлять правило без неё: ночью вопрос без тега — это
  // вкладка, которая простоит до утра зелёной, и утренняя сводка о нём не узнает.
  assert.ok(night.rule('').includes('[swarm:вопрос]'));
});

// Тело — то, что человек правит в настройках, — метку НЕ называет: за неё отвечает сворм.
// Держать её внутри редактируемого текста значило отдать протокол на попечение человеку.
test('в теле заготовки метки нет, в готовом тексте она есть', () => {
  assert.ok(!night.ruleBody().includes('[swarm:вопрос]'), night.ruleBody());
  assert.ok(!night.askBody().includes('[swarm:вопрос]'), night.askBody());
  assert.ok(night.rule('[swarm:вопрос]').includes('[swarm:вопрос]'));
  assert.ok(night.phaseAsk('[swarm:вопрос]').includes('[swarm:вопрос]'));
});

// Три ответа, а не два: вопрос «готово или ждём тебя» оставил бы ночь без выхода — агент,
// закрывший груминг, честно скажет «ждём», и вкладка простоит до утра.
test('вопрос про фазу предлагает три штатных ответа', () => {
  const q = night.phaseAsk('Сейчас от тебя');
  for (const n of ['(1)', '(2)', '(3)']) assert.ok(q.includes(n), q);
  assert.match(q, /Релиз не делай/);
});

test('правило требует остановиться там, где переделка дорогая', () => {
  const r = night.rule('Сейчас от тебя');
  assert.match(r, /обратимо или переделка дешёвая/);
  assert.match(r, /необратимое действие/);
});

// Итог — единственный рассказ о работе, который у человека есть: сворм видит поведение вкладки,
// а не результат. Поэтому проверяем не букву, а три обязательные части.
test('итог требует сказать, что решено без человека', () => {
  const t = night.summaryNote();
  assert.match(t, /итог/i, 'итог должен называться итогом');
  assert.match(t, /сам|без человека/i, 'итог обязан рассказать про решения без человека');
  assert.match(t, /осталось|проверять/i, 'итог обязан сказать, что осталось');
});

// --- свои формулировки --------------------------------------------------------
// Человек вправе сказать ночным агентам своё: уклад бывает другой. Не свободна одна вещь —
// метка вопроса: тег зашит в протокол, и текст без него оставит агента без способа сказать
// «жду утра». Поэтому в своём тексте метка пишется {тег}, а подставляет её сворм.
test('пустая формулировка — заготовка сворма', () => {
  assert.strictEqual(night.ruleText('', '[t]'), night.rule('[t]'));
  assert.strictEqual(night.ruleText('   ', '[t]'), night.rule('[t]'));
  assert.strictEqual(night.askText(null, '[t]'), night.phaseAsk('[t]'));
});

test('своя формулировка вытесняет заготовку, но не служебную строку', () => {
  assert.strictEqual(night.ruleText('Реши сам, спорное — утром.', '[t]'),
    'Реши сам, спорное — утром. ' + night.protocol('[t]'));
  assert.strictEqual(night.askText('Кончил или ждёшь?', '[t]'),
    'Кончил или ждёшь? ' + night.protocol('[t]') + ' ' + night.summaryNote());
});

// Ловушка, ради которой строку и вынесли: человек переписывает правило под свой уклад и метку не
// называет — раньше агент оставался без способа сказать «жду человека», вкладка стояла зелёной, и
// вопрос находили утром. Отказ тихий, поэтому его ловит тест, а не глаз.
test('свой текст без метки всё равно получает её', () => {
  const own = 'Ночью не трогай миграции и сеть, остальное решай сам.';
  assert.ok(night.ruleText(own, '[swarm:вопрос]').includes('[swarm:вопрос]'));
  assert.ok(night.askText(own, '[swarm:вопрос]').includes('[swarm:вопрос]'));
});

// А назвал сам — второй раз не повторяем: одна и та же просьба дважды подряд читается как две.
test('метка, названная в своём тексте, не дублируется', () => {
  const own = 'Стой и начни сообщение строкой [swarm:вопрос].';
  assert.strictEqual(night.ruleText(own, '[swarm:вопрос]'), own);
});

// Итог дописан СНАРУЖИ редактируемого текста — как и метка: человек, переписавший вопрос под
// свой уклад, унёс бы требование вместе с абзацем, и отказ был бы тихим.
test('вопрос про фазу зовёт написать итог — и к заготовке, и к своему тексту', () => {
  assert.ok(night.askText('', '[swarm:вопрос]').includes(night.summaryNote()),
    'заготовка потеряла итог');
  assert.ok(night.askText('Свой вопрос про фазу.', '[swarm:вопрос]').includes(night.summaryNote()),
    'свой текст потерял итог');
});

test('итог не повторяется, если он уже назван в тексте', () => {
  const t = night.askText('Спроси себя. ' + night.summaryNote(), '[swarm:вопрос]');
  assert.strictEqual(t.split('Задача кончилась').length - 1, 1, 'итог сказан дважды');
});

test('метка подставляется вместо {тег} в любом написании', () => {
  assert.strictEqual(night.ruleText('стой и пиши {тег}', '[swarm:вопрос]'), 'стой и пиши [swarm:вопрос]');
  assert.strictEqual(night.ruleText('write { TAG } and wait', '[q]'), 'write [q] and wait');
  assert.strictEqual(night.askText('вариант 3: {тег}', '[q]'), 'вариант 3: [q] ' + night.summaryNote());
});

// --- дубликаты в хуке ---------------------------------------------------------
// Хук запускается сам по себе, модулей приложения ему не видно, поэтому правило и пороги там
// свои. Разъехаться они не имеют права: агент, получающий разное правило от рамки и от толчка,
// ведёт себя случайно, а разные пороги значат, что ворота срабатывают не там, где обещано.
test('своя формулировка в хуке подставляет метку так же, как в приложении', async () => {
  const H = await import('../hooks/swarm-signal.mjs');
  for (const t of ['', '  ', null]) {
    assert.strictEqual(H.nightRuleText(t, '[q]'), night.ruleText(t, '[q]'));
  }
  const own = 'Ночь: реши сам, спорное — через {тег}.';
  assert.strictEqual(H.nightRuleText(own, '[swarm:вопрос]'), night.ruleText(own, '[swarm:вопрос]'));
});

test('ночное правило в хуке слово в слово совпадает с night.js', async () => {
  const H = await import('../hooks/swarm-signal.mjs');
  assert.strictEqual(H.nightRule('Сейчас от тебя'), night.rule('Сейчас от тебя'));
  assert.strictEqual(H.nightRule('Позови меня'), night.rule('Позови меня'));
});

test('просьба про итог в хуке слово в слово совпадает с night.js', async () => {
  const H = await import('../hooks/swarm-signal.mjs');
  assert.strictEqual(H.summaryNote(), night.summaryNote());
});

test('пороги ворот в хуке те же, что в night.js', async () => {
  const H = await import('../hooks/swarm-signal.mjs');
  assert.strictEqual(H.GATE_FIVE, night.GATE_FIVE);
  assert.strictEqual(H.GATE_SEVEN, night.GATE_SEVEN);
});

// Отсчёт до сброса пишут двое: хук (в заметке про расход) и строка статуса. Оба текста человек
// читает рядом, и разъехавшийся формат читается как разные числа.
test('отсчёт до сброса в хуке и в строке статуса пишется одинаково', async () => {
  const H = await import('../hooks/swarm-signal.mjs');
  const SL = require('../swarm-statusline');
  for (const sec of [0, 59, 60, 3600, 3660, 86_400, 90_000]) {
    assert.strictEqual(H.fmtEta(sec), SL.fmtEta(sec), 'sec=' + sec);
  }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\nnight: ${passed}/${tests.length} ok`);
})();
