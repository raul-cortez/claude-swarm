// Что в байтах из xterm сказал ТЕРМИНАЛ, а не человек (renderer/termtalk.js).
//
// Живой случай, ради которого модуль и написан: вкладку отдали агенту (ночной режим), человек
// её открывает — и получает очередь модалок «Забрать вкладку себе?», из которой не выйти. Гейт
// владения висел на term.onData и считал печатью ВСЁ, что оттуда приходит, а приходит туда не
// только печать: Клод включает отслеживание мыши (1000/1002/1003/1006), и каждое движение
// указателя над вкладкой — доклад мыши; плюс терминал сам отвечает на запросы приложения
// (кто ты, где курсор, какой фон, какого размера окно). Первое давало модалку на каждое
// шевеление мышью, второе гейт придерживал и по «Отмене» выбрасывал — а приложение своего
// ответа ждёт.
//
// Проверять поштучно можно потому, что onData зовут ровно раз на каждое отправленное
// сообщение: один кусок — одно событие, смеси «доклад + клавиша» в нём не бывает.
const assert = require('assert');
const { isTerminalTalk } = require('../renderer/termtalk');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// --- говорит терминал ---------------------------------------------------------------------

test('доклады мыши: SGR (1006), пиксельный, urxvt (1015), старый формат', () => {
  assert.strictEqual(isTerminalTalk('\x1b[<35;80;24M'), true);   // движение с зажатой кнопкой
  assert.strictEqual(isTerminalTalk('\x1b[<0;12;5M'), true);     // нажали
  assert.strictEqual(isTerminalTalk('\x1b[<0;12;5m'), true);     // отпустили
  assert.strictEqual(isTerminalTalk('\x1b[<64;12;5M'), true);    // колесо
  assert.strictEqual(isTerminalTalk('\x1b[<35;480;120M'), true); // SGR_PIXELS — те же байты
  assert.strictEqual(isTerminalTalk('\x1b[35;80;24M'), true);    // urxvt
  assert.strictEqual(isTerminalTalk('\x1b[M !!'), true);         // X10: три сырых байта следом
});

test('ответы терминала на запросы приложения', () => {
  assert.strictEqual(isTerminalTalk('\x1b[?1;2c'), true);        // DA1 «кто ты»
  assert.strictEqual(isTerminalTalk('\x1b[?6c'), true);
  assert.strictEqual(isTerminalTalk('\x1b[>0;276;0c'), true);    // DA2
  assert.strictEqual(isTerminalTalk('\x1b[0n'), true);           // DSR «жив»
  assert.strictEqual(isTerminalTalk('\x1b[24;80R'), true);       // где курсор
  assert.strictEqual(isTerminalTalk('\x1b[?24;80R'), true);
  assert.strictEqual(isTerminalTalk('\x1b[?2026;2$y'), true);    // DECRPM: поддержан ли режим
  assert.strictEqual(isTerminalTalk('\x1b[4;600;800t'), true);   // размер окна в пикселях
  assert.strictEqual(isTerminalTalk('\x1b[8;24;80t'), true);     // размер в клетках
  assert.strictEqual(isTerminalTalk('\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\'), true);  // цвет фона
  assert.strictEqual(isTerminalTalk('\x1b]10;rgb:ffff/ffff/ffff\x07'), true);    // он же через BEL
  assert.strictEqual(isTerminalTalk('\x1bP1$r0m\x1b\\'), true);  // DECRQSS
});

test('отметки фокуса — тоже терминал', () => {
  assert.strictEqual(isTerminalTalk('\x1b[I'), true);
  assert.strictEqual(isTerminalTalk('\x1b[O'), true);
});

// --- говорит человек ----------------------------------------------------------------------

test('печать и правка — не терминал', () => {
  assert.strictEqual(isTerminalTalk('a'), false);
  assert.strictEqual(isTerminalTalk('привет'), false);
  assert.strictEqual(isTerminalTalk('\r'), false);
  assert.strictEqual(isTerminalTalk('\x7f'), false);             // Backspace
  assert.strictEqual(isTerminalTalk('\x03'), false);             // Ctrl+C — прерывает агента
  assert.strictEqual(isTerminalTalk('\x1b'), false);             // Esc — тоже прерывает
});

test('клавиши-последовательности остаются печатью: их гейт обязан придержать', () => {
  assert.strictEqual(isTerminalTalk('\x1b[A'), false);           // стрелка вверх
  assert.strictEqual(isTerminalTalk('\x1bOA'), false);           // она же в прикладном режиме
  assert.strictEqual(isTerminalTalk('\x1b[1;5C'), false);        // Ctrl+вправо
  assert.strictEqual(isTerminalTalk('\x1b[3~'), false);          // Delete
  assert.strictEqual(isTerminalTalk('\x1b[Z'), false);           // Shift+Tab
  assert.strictEqual(isTerminalTalk('\x1bOP'), false);           // F1
  assert.strictEqual(isTerminalTalk('\x1b[15~'), false);         // F5
});

test('вставка из буфера — печать целиком, вместе с рамкой bracketed paste', () => {
  assert.strictEqual(isTerminalTalk('\x1b[200~сделай тише\x1b[201~'), false);
});

test('пустое и мусор терминалом не считаются', () => {
  assert.strictEqual(isTerminalTalk(''), false);
  assert.strictEqual(isTerminalTalk(null), false);
  assert.strictEqual(isTerminalTalk(undefined), false);
});

test('смесь доклада с печатью — печать: сомнение решается в пользу гейта', () => {
  assert.strictEqual(isTerminalTalk('a\x1b[<0;1;1M'), false);
  assert.strictEqual(isTerminalTalk('\x1b[<0;1;1Ma'), false);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
