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
    project: '', tab: '', auto: false, status: '', detail: '', digest: '',
  });
});

test('реестр сериализуется в JSON без потерь — его читает чужой процесс', () => {
  const body = JSON.stringify(P.rows([['t1', tab()]]));
  assert.deepStrictEqual(JSON.parse(body).t1.project, 'fastio-686');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ok — ' + name); }
    catch (e) { console.error('FAIL — ' + name + '\n  ' + e.message); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
