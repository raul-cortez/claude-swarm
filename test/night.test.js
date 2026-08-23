// Ночной режим: решения (толкать / спросить / оставить стоять), журнал и утренняя сводка.
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
    presence: 'night', kind: 'question', box: false,
    now: NOW, startedAt: OLD, fingerprint: 'мигрировать ли старый формат',
  }, over || {});
}

function readyCtx(over) {
  return Object.assign({
    presence: 'night', status: 'ready', bg: false, limited: false,
    now: NOW, startedAt: OLD, readyAt: NOW - night.IDLE_MS - 1000, turn: OLD,
  }, over || {});
}

// --- толчок в ждущую вкладку --------------------------------------------------

test('вопрос прозой ночью получает толчок', () => {
  const d = night.nudgeDecision({}, waitCtx());
  assert.strictEqual(d.act, 'nudge');
});

test('днём ночь не трогает вкладки вовсе', () => {
  for (const p of ['desk', 'phone']) {
    assert.strictEqual(night.nudgeDecision({}, waitCtx({ presence: p })).act, 'skip');
    assert.strictEqual(night.phaseDecision({}, readyCtx({ presence: p })).act, 'skip');
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

test('новый вопрос через три часа — новый толчок', () => {
  const st = { nudges: 1, nudgedKeys: ['совсем другой вопрос'] };
  assert.strictEqual(night.nudgeDecision(st, waitCtx()).act, 'nudge');
});

test('потолок толчков за ночь не переступается', () => {
  const st = { nudges: night.MAX_NUDGES, nudgedKeys: [] };
  const d = night.nudgeDecision(st, waitCtx());
  assert.strictEqual(d.act, 'stand');
  assert.match(d.why, /потолок/);
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

test('правило называет тег, которым агент должен закончить ход', () => {
  const r = night.rule('[вопрос]');
  assert.ok(r.includes('закончи ход тегом [вопрос]'), r);
  // Пустая метка не должна оставлять правило без неё: ночью вопрос без тега — это
  // вкладка, которая простоит до утра зелёной, и утренняя сводка о нём не узнает.
  assert.ok(night.rule('').includes('[вопрос]'));
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

// --- журнал -------------------------------------------------------------------

test('запись журнала переживает круг через строку', () => {
  const e = night.entry('nudge', 'вкладка A', { at: NOW, text: 'вопрос' });
  const back = night.parse(night.line(e));
  assert.strictEqual(back.length, 1);
  assert.deepStrictEqual(back[0], e);
});

// Журнал пишут два процесса (приложение и хук), и обрыв на середине строки — обычное дело при
// выключении. Потерять из-за него всю сводку было бы глупо.
test('битые и чужие строки журнала пропускаются молча', () => {
  const good = night.line(night.entry('nudge', 'A', { at: NOW }));
  const text = '{"половина строки\n' + good + '{"kind":"чужое","at":1}\n{"kind":"nudge"}\n';
  const back = night.parse(text);
  assert.strictEqual(back.length, 1);
  assert.strictEqual(back[0].kind, 'nudge');
});

test('журнал отдаётся по времени, даже если записан вперемешку', () => {
  const late = night.line(night.entry('nudge', 'A', { at: NOW + 10 }));
  const early = night.line(night.entry('stand', 'B', { at: NOW }));
  const back = night.parse(late + early);
  assert.deepStrictEqual(back.map((e) => e.tab), ['B', 'A']);
});

// --- утренняя сводка ----------------------------------------------------------

function sampleDigest() {
  const entries = [
    night.entry('deny-box', 'миграция', { at: NOW - 5 * 3600_000, id: '1', text: 'мигрировать молча или спросить?', options: ['молча', 'спросить'] }),
    night.entry('nudge', 'миграция', { at: NOW - 4 * 3600_000, id: '1', text: 'какой формат' }),
    night.entry('continue', 'док', { at: NOW - 3 * 3600_000, id: '2', n: 1, text: 'начал реализацию по плану' }),
    night.entry('limit', 'тесты', { at: NOW - 2 * 3600_000, id: '3', until: NOW - 3600_000 }),
    night.entry('wake', 'тесты', { at: NOW - 3600_000 + 120_000, id: '3' }),
    night.entry('done', 'док', { at: NOW - 600_000, id: '2', text: 'всё зелёное' }),
    night.entry('died', 'старая', { at: NOW - 500_000, id: '9' }),
  ];
  const tabs = [
    { id: '1', name: 'миграция', status: 'waiting', waitingKind: 'question', question: 'выбрать формат настроек?', since: NOW - 3600_000 },
    { id: '4', name: 'сборка', status: 'waiting', waitingKind: 'permission', question: 'rm -rf build?', since: NOW - 7 * 3600_000 },
    { id: '2', name: 'док', status: 'ready', waitingKind: null, question: '', since: 0 },
  ];
  return night.digest(entries, tabs, NOW, { from: NOW - 8 * 3600_000 });
}

test('сводка ставит первым то, что блокирует работу', () => {
  const ids = sampleDigest().groups.map((g) => g.id);
  assert.strictEqual(ids[0], 'wait');
  assert.strictEqual(ids[1], 'perm');
  // «Решено без тебя» обязано быть в сводке: это очередь на ревью.
  assert.ok(ids.includes('decided'), ids.join(','));
  assert.ok(ids.indexOf('done') > ids.indexOf('decided'), ids.join(','));
});

test('пустые группы в сводку не попадают', () => {
  const dg = night.digest([], [], NOW, { from: NOW - 1000 });
  assert.deepStrictEqual(dg.groups, []);
  assert.strictEqual(dg.totals.standing, 0);
});

test('итог считает решения и стоящих, а не строки журнала', () => {
  const t = sampleDigest().totals;
  assert.strictEqual(t.standing, 2);            // вопрос + разрешение
  assert.strictEqual(t.decided, 2);             // развилка хука + продолжение
  assert.match(t.night, /^8ч/);
});

test('разрешение и вопрос разведены по группам', () => {
  const dg = sampleDigest();
  const wait = dg.groups.find((g) => g.id === 'wait');
  const perm = dg.groups.find((g) => g.id === 'perm');
  assert.strictEqual(wait.rows.length, 1);
  assert.strictEqual(perm.rows.length, 1);
  assert.match(perm.rows[0].text, /rm -rf/);
  // «Стоит семь часов» — это и есть цена решения «разрешения ночью не трогаем».
  assert.match(perm.rows[0].meta, /7ч/);
});

test('развилка в сводке — дословная, с вариантами', () => {
  const row = sampleDigest().groups.find((g) => g.id === 'decided').rows[0];
  assert.match(row.text, /мигрировать молча или спросить/);
  assert.match(row.meta, /варианты: молча \/ спросить/);
});

test('лимит рассказывает и про сон, и про подъём', () => {
  const row = sampleDigest().groups.find((g) => g.id === 'limit').rows[0];
  assert.match(row.text, /разбудили сами/);
  assert.match(row.meta, /потеряно/);
});

test('незакрытый лимит не выдаёт себя за разбуженный', () => {
  const dg = night.digest([night.entry('limit', 'тесты', { at: NOW - 3600_000, until: NOW + 3600_000 })], [], NOW, {});
  const row = dg.groups.find((g) => g.id === 'limit').rows[0];
  assert.match(row.text, /упёрлась в лимит/);
  assert.doesNotMatch(row.text, /разбудили/);
});

test('вопрос в сводке берётся из живого состояния, а не из журнала', () => {
  // В журнале лежит «какой формат» (текст на момент толчка), а на экране уже дописанный вопрос.
  const row = sampleDigest().groups.find((g) => g.id === 'wait').rows[0];
  assert.match(row.text, /выбрать формат настроек/);
});

// Записи хука знают только id разговора Клода; имя подставляет приложение, и только если такая
// вкладка ещё жива (после самоперезапуска id другой). В окне рендерер прикрывал дыру своим
// умолчанием, а текст для /morning печатал «• undefined — …».
test('запись без имени вкладки не превращается в undefined', () => {
  const e = night.entry('deny-box', '', { at: NOW, text: 'мигрировать молча?' });
  const dg = night.digest([e], [], NOW, { from: NOW - 1000 });
  assert.strictEqual(dg.groups[0].rows[0].tab, 'вкладка');
  assert.doesNotMatch(night.digestText(dg), /undefined/);
});

test('сводка словами повторяет те же числа, что и окно', () => {
  const dg = sampleDigest();
  const text = night.digestText(dg);
  assert.match(text, /Решений без тебя 2, стоят 2/);
  for (const g of dg.groups) assert.ok(text.includes(g.title), g.title);
});

// --- дубликаты в хуке ---------------------------------------------------------
// Хук запускается сам по себе, модулей приложения ему не видно, поэтому правило и пороги там
// свои. Разъехаться они не имеют права: агент, получающий разное правило от рамки и от толчка,
// ведёт себя случайно, а разные пороги значат, что ворота срабатывают не там, где обещано.
test('ночное правило в хуке слово в слово совпадает с night.js', async () => {
  const H = await import('../hooks/swarm-signal.mjs');
  assert.strictEqual(H.nightRule('Сейчас от тебя'), night.rule('Сейчас от тебя'));
  assert.strictEqual(H.nightRule('Позови меня'), night.rule('Позови меня'));
});

test('пороги ворот в хуке те же, что в night.js', async () => {
  const H = await import('../hooks/swarm-signal.mjs');
  assert.strictEqual(H.GATE_FIVE, night.GATE_FIVE);
  assert.strictEqual(H.GATE_SEVEN, night.GATE_SEVEN);
});

test('отсчёт до сброса в хуке и в сводке пишется одинаково', async () => {
  const H = await import('../hooks/swarm-signal.mjs');
  for (const sec of [0, 59, 60, 3600, 3660, 86_400, 90_000]) {
    assert.strictEqual(H.fmtEta(sec), night.eta(sec * 1000), 'sec=' + sec);
  }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\nnight: ${passed}/${tests.length} ok`);
})();
