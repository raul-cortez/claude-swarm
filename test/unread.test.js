// Plain-node tests for the «непрочитанный ответ» flag (unread.js).
//
// Цена ошибки двусторонняя, и обе стороны дорогие. Пометка не встала — вкладку гасят вместе с
// ответом, которого человек не видел, и он об этом даже не узнает: свежая сессия про прошлый
// разговор не помнит. Пометка не снялась — вкладка стоит с полным контекстом вместо работы.
// Поэтому проверяем каждый способ поставить пометку и каждый способ её снять.
const assert = require('assert');
const U = require('../unread.js');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const NOW = 10 * 3600 * 1000;

// Ход, который начал ЧЕЛОВЕК: он отправил сообщение и ждёт, что ему ответят.
function asked() {
  return U.onHumanSend(U.initial());
}

test('свежая вкладка непрочитанного не держит', () => {
  assert.strictEqual(U.isUnread(U.initial()), false);
});

// Главный случай, ради которого всё и делается: ты спросил, агент ответил, а ты в этот момент
// смотрел в другую вкладку. Ответ на экране есть, но не у тебя перед глазами.
test('ход по твоей просьбе кончился мимо твоих глаз — непрочитано', () => {
  const st = U.onTurnEnd(asked(), { now: NOW, viewing: false, done: true });
  assert.strictEqual(U.isUnread(st), true);
});

test('переключился на вкладку — прочитал', () => {
  const st = U.onTurnEnd(asked(), { now: NOW, viewing: false, done: true });
  assert.strictEqual(U.isUnread(U.onViewed(st)), false);
});

// Служебный круг сворма: он сам напечатал агенту просьбу о перезапуске (или уже держит на руках
// разрешение) и ждёт. Всё, что агент говорит внутри круга, адресовано сворму — и пометкой лечь не
// должно, даже если человек когда-то раньше писал в эту вкладку и его ожидание всё ещё открыто.
//
// Живой случай, ради которого отметка и заведена: агент разрешил перезапуск словами «вкладку можно
// гасить», сворм разрешение принял — и сам себе его запретил, потому что конец того же хода стал
// «ответом, которого человек не видел». Снять такую пометку было нечем: отвечать на «от тебя
// ничего» человек не станет.
test('служебный круг сворма пометки не ставит', () => {
  const svc = U.onSwarmAsk(asked());
  const st = U.onTurnEnd(svc, { now: NOW, viewing: true, done: true, needsYou: true });
  assert.strictEqual(U.isUnread(st), false);
});

test('круг закрылся — следующий ход помечается как обычно', () => {
  const svc = U.onSwarmAsk(asked());
  const back = U.onSwarmIdle(U.onTurnEnd(svc, { now: NOW, done: true, needsYou: true }));
  const st = U.onTurnEnd(back, { now: NOW + 1000, viewing: false, done: true, needsYou: true });
  assert.strictEqual(U.isUnread(st), true);
});

// Человек написал во вкладку, пока шёл служебный круг. Дальше в ней говорят с ним, и его ожидание
// перебивает наше: итог такого хода он ждёт по-настоящему.
test('человек вмешался в служебный круг — итог снова его', () => {
  const svc = U.onSwarmAsk(asked());
  const mine = U.onHumanSend(svc);
  const st = U.onTurnEnd(mine, { now: NOW, viewing: false, done: true, needsYou: true });
  assert.strictEqual(U.isUnread(st), true);
});

// А вот если ответ лёг ПРЯМО ТЕБЕ В ГЛАЗА — вкладка была открыта и окно в фокусе, — то
// «переключение на неё» уже случиться не может: ты и так на неё смотришь. Значит снять пометку
// нечем, кроме твоего ответа. Иначе она снималась бы сама собой в тот же миг, в который встала,
// и весь сторож existed бы только на бумаге.
test('ответ лёг тебе прямо в глаза — снимает только твой ответ, не взгляд', () => {
  const st = U.onTurnEnd(asked(), { now: NOW, viewing: true, done: true, needsYou: true });
  assert.strictEqual(U.isUnread(st), true);
  assert.strictEqual(U.isUnread(U.onViewed(st)), true, 'взгляд на открытую вкладку — не событие');
  assert.strictEqual(U.isUnread(U.onHumanSend(st)), false, 'а ответ — событие');
});

// А строгость эта держится ровно до тех пор, пока от человека чего-то ждут. Ход, кончившийся
// словами «Сейчас от тебя: ничего», ответа не просит — и строгая пометка на нём была замком без
// ключа: снять её мог только ответ, которого агент сам не ждал. Вкладка стояла с готовым
// разрешением на перезапуск, пока человек не напишет ей что-нибудь просто так.
test('«от тебя ничего» на глазах у человека — прочитано сразу', () => {
  const st = U.onTurnEnd(asked(), { now: NOW, viewing: true, done: true, needsYou: false });
  assert.strictEqual(U.isUnread(st), false);
});

test('«от тебя ничего» мимо глаз — пометка есть, но её снимает взгляд', () => {
  const st = U.onTurnEnd(asked(), { now: NOW, viewing: false, done: true, needsYou: false });
  assert.strictEqual(U.isUnread(st), true, 'сказанное всё равно надо увидеть');
  assert.strictEqual(U.isUnread(U.onViewed(st)), false);
});

test('твой ответ снимает пометку и в мягком случае тоже', () => {
  const st = U.onTurnEnd(asked(), { now: NOW, viewing: false, done: true });
  assert.strictEqual(U.isUnread(U.onHumanSend(st)), false);
});

// Ночной прогон: человек ничего не спрашивал, агента разбудила фоновая задача или расписание.
// Ждать ему нечего, и вкладка должна перезапускаться как обычно. Этим же условием отсекается и
// служебный ход самого сворма — просьба о перезапуске приходит не от человека.
test('ход без твоей просьбы пометки не ставит', () => {
  const st = U.onTurnEnd(U.initial(), { now: NOW, viewing: false, done: true });
  assert.strictEqual(U.isUnread(st), false);
  // И следующий за ним — тоже: один служебный круг не делает вкладку ждущей.
  assert.strictEqual(U.isUnread(U.onTurnEnd(st, { now: NOW + 1, done: true })), false);
});

// Человек успел вмешаться в служебный круг: сворм печатал агенту просьбу о перезапуске, а
// человек в это же время написал во вкладку сам. Итога такого хода ЖДУТ — и пометка нужна,
// хотя круг начинал не человек. Разбирай мы это по метке «ход завёл сворм», ответ человеку
// потерялся бы именно здесь.
test('вмешался в служебный круг — итога всё равно ждут', () => {
  const st = U.onTurnEnd(asked(), { now: NOW, viewing: false, done: true });
  assert.strictEqual(U.isUnread(st), true);
});

// «Ничего, жду замер стенда» — ход отдан, но разговор не кончен: настоящий ответ будет потом.
// Пометку ставим уже сейчас (сказанное тоже надо прочитать), но ожидание не закрываем, иначе
// финальный ответ — тот самый, ради которого всё затевалось, — пришёл бы уже непомеченным.
test('уход в фон помечает, но ожидание оставляет открытым', () => {
  const bg = U.onTurnEnd(asked(), { now: NOW, viewing: false, done: false });
  assert.strictEqual(U.isUnread(bg), true);
  // Человек прочитал промежуточное — пометка снята, но ход всё ещё его.
  const seen = U.onViewed(bg);
  assert.strictEqual(U.isUnread(seen), false);
  const fin = U.onTurnEnd(seen, { now: NOW + 1000, viewing: false, done: true });
  assert.strictEqual(U.isUnread(fin), true, 'итоговый ответ тоже ждёт глаз');
});

// Строгость пересчитывается на КАЖДОМ конце хода, а не запоминается с первого: между
// промежуточным докладом и итогом человек успевает и прийти, и уйти.
test('строгость берётся от последнего ответа, а не от первого', () => {
  const bg = U.onTurnEnd(asked(), { now: NOW, viewing: true, done: false, needsYou: true });
  const fin = U.onTurnEnd(bg, { now: NOW + 1000, viewing: false, done: true, needsYou: true });
  assert.strictEqual(U.isUnread(U.onViewed(fin)), false, 'итог лёг мимо глаз — взгляд снимает');
});

test('взгляд на вкладку без пометки ничего не ломает', () => {
  const st = U.onViewed(U.initial());
  assert.strictEqual(U.isUnread(st), false);
  // И следующий ход после этого помечается как обычно.
  assert.strictEqual(U.isUnread(U.onTurnEnd(U.onHumanSend(st), { now: NOW, done: true })), true);
});

// Перезапуск вкладки — это новый агент и новый разговор: непрочитанное прошлой сессии
// уезжает вместе с ней, и тащить пометку через смерть агента незачем.
test('сброс возвращает вкладку в чистое состояние', () => {
  const st = U.onTurnEnd(asked(), { now: NOW, viewing: true, done: true });
  assert.deepStrictEqual(U.initial(), U.reset(st));
});

// Зов файлом: агент не дожидается просьбы сворма, а кладёт разрешение сам и на том же ходу
// прощается («эстафета записана, перезапускаюсь»). Служебный круг тут открыть НЕКОГДА: сворм
// узнаёт о зове тактом, то есть уже после того, как ход кончился и пометка встала.
//
// Живой случай (24.08, вкладка fastio 4): файл лёг в 22:14:22, ход кончился в 22:14:36, сворм
// принял зов в 22:14:47 — и упёрся в пометку от собственного же прощального хода. Часы разрешения
// под непрочитанным намеренно стоят, так что ждал он бы вечно. Поэтому отметка снимается задним
// числом: пометку, вставшую не раньше зова, ставил тот самый служебный ход.
test('зов файлом: прощальный ход агента пометки не оставляет', () => {
  const st = U.onTurnEnd(asked(), { now: NOW, viewing: false, done: true, needsYou: true });
  assert.strictEqual(U.isUnread(st), true, 'сначала пометка есть');
  assert.strictEqual(U.isUnread(U.onSwarmAsk(st, { since: NOW - 14000 })), false);
});

// И строгую тоже: «жми перезапуск руками» — это needsYou на открытой вкладке, то есть замок,
// который не снимает даже взгляд. Ровно им вкладка себя и заперла.
test('зов файлом снимает и строгую пометку того же хода', () => {
  const st = U.onTurnEnd(asked(), { now: NOW, viewing: true, done: true, needsYou: true });
  assert.strictEqual(U.isUnread(U.onViewed(st)), true, 'строгую взглядом не снять');
  assert.strictEqual(U.isUnread(U.onSwarmAsk(st, { since: NOW - 1000 })), false);
});

// А вот чужого долга зов не отменяет. Ответ, лёгший ДО того, как агент позвал перезапуск, человек
// действительно не видел, и правило владельца про него в силе: ждём глаз, сколько нужно.
test('ответ, лёгший до зова, держит по-прежнему', () => {
  const st = U.onTurnEnd(asked(), { now: NOW, viewing: false, done: true });
  assert.strictEqual(U.isUnread(U.onSwarmAsk(st, { since: NOW + 1000 })), true);
});

// Путь «сворм спросил» отметку ставит ДО хода, и снимать ему нечего: без времени зова
// onSwarmAsk работает как раньше.
test('без времени зова onSwarmAsk пометку не трогает', () => {
  const st = U.onTurnEnd(asked(), { now: NOW, viewing: false, done: true });
  assert.strictEqual(U.isUnread(U.onSwarmAsk(st)), true);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; } catch (e) {
    console.error(`FAIL ${name}\n  ${e.message}`);
    process.exit(1);
  }
}
console.log(`unread: ${passed}/${tests.length} ok`);
