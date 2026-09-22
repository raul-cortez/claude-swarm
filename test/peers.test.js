// Реестр вкладок для соседних сессий: что попадает в визитку и что в неё не попадает.
// Run: node test/peers.test.js
const assert = require('assert');
const P = require('../peers');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const tab = (over = {}) => Object.assign({
  cwd: '/Users/e/WebstormProjects/fastio-686',
  sessionKey: 'swarm-fastio-686-a3f9',
  claudeSessionId: 'c0ffee',
  name: 'Фастио 686',
  auto: true,
  status: 'waiting',
  detail: 'ждёт ответа',
  digestText: 'Чиню приём филиалов чужого заведения в членство',
}, over);

test('визитка несёт проект, мандат и статус — то, чего нет в имени сессии', () => {
  const r = P.rows([['t1', tab()]]).t1;
  assert.strictEqual(r.project, 'fastio-686');
  assert.strictEqual(r.tab, 'Фастио 686');
  assert.strictEqual(r.auto, true);
  assert.strictEqual(r.status, 'waiting');
  assert.strictEqual(r.detail, 'ждёт ответа');
  assert.strictEqual(r.digest, 'Чиню приём филиалов чужого заведения в членство');
});

test('прежние три поля на месте — у файла есть обязанность старше этой', () => {
  // swarm-tabs.json разбирают после жёсткого креша, чтобы понять, каким разговором была
  // вкладка. Переименуй их — и разбор креша сломается молча.
  const r = P.rows([['t1', tab()]]).t1;
  assert.strictEqual(r.cwd, '/Users/e/WebstormProjects/fastio-686');
  assert.strictEqual(r.sessionKey, 'swarm-fastio-686-a3f9');
  assert.strictEqual(r.claudeSessionId, 'c0ffee');
});

test('мёртвых и безымянных в реестре нет — это приглашение писать в пустоту', () => {
  const rows = P.rows([
    ['live', tab()],
    ['dead', tab({ dead: true })],
    ['noconv', tab({ claudeSessionId: undefined })],
    ['nothing', null],
  ]);
  assert.deepStrictEqual(Object.keys(rows), ['live']);
});

test('проект в визитке — как каталог назван, без санитайзера командной строки', () => {
  // Здесь ограничений resume.js нет: поле читают глазами, а не подставляют в команду.
  assert.strictEqual(P.projectOf('/Users/e/Проекты/касса'), 'касса');
  assert.strictEqual(P.projectOf('C:\\Projects\\Fastio'), 'Fastio');
  assert.strictEqual(P.projectOf('/Users/e/fastio/'), 'fastio');
  assert.strictEqual(P.projectOf(''), '');
  assert.strictEqual(P.projectOf(null), '');
  assert.strictEqual(P.projectOf('/'), '');
});

test('дайджест обрезан: реестр читают целиком, десятью строками разом', () => {
  const long = 'Разбираю, почему филиалы чужого заведения принимаются в членство. '.repeat(5);
  const r = P.rows([['t1', tab({ digestText: long })]]).t1;
  assert.ok(r.digest.length <= P.DIGEST_MAX, r.digest.length);
  assert.ok(r.digest.endsWith('…'), r.digest);
  assert.ok(!/[\s,;:.—-]…$/.test(r.digest), 'повисший знак перед многоточием: ' + r.digest);
});

test('короткий дайджест не трогаем и многоточие не дорисовываем', () => {
  const r = P.rows([['t1', tab({ digestText: '  Чиню\n  членство  ' })]]).t1;
  assert.strictEqual(r.digest, 'Чиню членство');
});

test('пустые поля не роняют визитку — вкладка могла ещё ничего о себе не сказать', () => {
  const r = P.rows([['t1', { claudeSessionId: 'c0ffee' }]]).t1;
  assert.deepStrictEqual(r, {
    cwd: '', sessionKey: '', claudeSessionId: 'c0ffee',
    project: '', tab: '', auto: false, parentId: null, crew: false,
    status: '', detail: '', digest: '',
  });
});

test('родство и роль прораба тоже в визитке — по ним читатель решает, кто кого видит', () => {
  const r1 = P.rows([['t1', tab({ parentId: 't0' })]]).t1;
  assert.strictEqual(r1.parentId, 't0');
  const r2 = P.rows([['t2', tab({ crew: true })]]).t2;
  assert.strictEqual(r2.crew, true);
  const r3 = P.rows([['t3', tab()]]).t3;
  assert.strictEqual(r3.parentId, null);
  assert.strictEqual(r3.crew, false);
});

test('реестр сериализуется в JSON без потерь — его читает чужой процесс', () => {
  const body = JSON.stringify(P.rows([['t1', tab()]]));
  assert.deepStrictEqual(JSON.parse(body).t1.project, 'fastio-686');
});

// --- кто что видит: viewFor(rows, sid) --------------------------------------------
// Спека: docs/superpowers/specs/2026-09-22-crew-design.md, раздел «Кто что видит».
// Таблица случаев — прораб, ребёнок, одиночка, мёртвый прораб — по просьбе из эстафеты
// (docs/superpowers/plans/2026-09-22-crew-orchestrator.md): решение о видимости принимается
// здесь, а не в UI, и проверяется здесь же.

test('прораб видит свою бригаду и число свободных — не всех подряд', () => {
  const rows = P.rows([
    ['boss', tab({ claudeSessionId: 'boss-sid', crew: true })],
    ['kid1', tab({ claudeSessionId: 'kid1-sid', parentId: 'boss' })],
    ['kid2', tab({ claudeSessionId: 'kid2-sid', parentId: 'boss' })],
    ['free', tab({ claudeSessionId: 'free-sid' })], // одиночка, не в бригаде
  ]);
  const view = P.viewFor(rows, 'boss-sid');
  assert.strictEqual(view.role, 'prorab');
  assert.deepStrictEqual(Object.keys(view.crew).sort(), ['kid1', 'kid2']);
  assert.strictEqual(view.free, 1);
});

test('прораб остаётся прорабом с нулём детей — роль не снимается', () => {
  const rows = P.rows([
    ['boss', tab({ claudeSessionId: 'boss-sid', crew: true })],
    ['free', tab({ claudeSessionId: 'free-sid' })],
  ]);
  const view = P.viewFor(rows, 'boss-sid');
  assert.strictEqual(view.role, 'prorab');
  assert.deepStrictEqual(view.crew, {});
  assert.strictEqual(view.free, 1);
});

test('ребёнок видит только своего прораба, не всю бригаду и не свободных', () => {
  const rows = P.rows([
    ['boss', tab({ claudeSessionId: 'boss-sid', crew: true })],
    ['kid1', tab({ claudeSessionId: 'kid1-sid', parentId: 'boss' })],
    ['kid2', tab({ claudeSessionId: 'kid2-sid', parentId: 'boss' })],
  ]);
  const view = P.viewFor(rows, 'kid1-sid');
  assert.strictEqual(view.role, 'child');
  assert.strictEqual(view.parentId, 'boss');
  assert.strictEqual(view.parent.tab, tab().name);
  assert.strictEqual(view.parent.crew, true);
});

test('одиночка видит всё как раньше — реестр без фильтра', () => {
  const rows = P.rows([
    ['t1', tab({ claudeSessionId: 's1' })],
    ['t2', tab({ claudeSessionId: 's2' })],
  ]);
  const view = P.viewFor(rows, 's1');
  assert.strictEqual(view.role, 'solo');
  assert.deepStrictEqual(view.rows, rows);
});

test('нет своей строки в реестре — фильтровать не от чего, отдаём всё как одиночке', () => {
  const rows = P.rows([['t1', tab({ claudeSessionId: 's1' })]]);
  assert.deepStrictEqual(P.viewFor(rows, 'неизвестный-sid'), { role: 'solo', rows });
  assert.deepStrictEqual(P.viewFor(rows, ''), { role: 'solo', rows });
});

test('мёртвый прораб — ребёнок остаётся в бригаде и ждёт, реестр только рассказывает', () => {
  // rows() мёртвых уже не пишет (см. тест выше), поэтому строки прораба в реестре нет —
  // ровно то, что видит хук, когда прораб упал или перезапускается.
  const rows = P.rows([
    ['kid1', tab({ claudeSessionId: 'kid1-sid', parentId: 'boss' })],
  ]);
  const view = P.viewFor(rows, 'kid1-sid');
  assert.strictEqual(view.role, 'child');
  assert.strictEqual(view.parentId, 'boss');
  assert.strictEqual(view.parent, null);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ok — ' + name); }
    catch (e) { console.error('FAIL — ' + name + '\n  ' + e.message); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
