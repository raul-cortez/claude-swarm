// Контрактный тест: в main.js и рендерере нет вызовов функций, которых нет.
//
// Зачем отдельный тест на такую, казалось бы, глупость. Линтера в проекте нет, `node --check`
// видит только синтаксис, а main.js — пять тысяч строк. Сегодняшний случай: при уборке мёртвого
// кода вырезали определение функции, а её вызов остался — приложение падало на старте, и ни один
// из тридцати тестов этого не видел. Такую ошибку ловят либо запуском приложения, либо вот этим.
//
// Проверка нарочно грубая и без AST: срезаем комментарии, строки и регулярки, собираем всё, что
// объявлено в файле, и сверяем с тем, что вызывается. Ошибиться она может только в сторону
// ложной тревоги — тогда имя добавляется в KNOWN_GLOBALS с объяснением, зачем.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// Хозяйство языка и среды. Всё, что не объявлено в самом файле и не отсюда, — подозрительно.
const KNOWN_GLOBALS = new Set([
  // язык
  'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date', 'Promise', 'Error',
  'RegExp', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Symbol', 'BigInt', 'Proxy', 'Reflect', 'Intl',
  'Uint8Array', 'Float32Array', 'Int16Array', 'ArrayBuffer', 'DataView',
  'isFinite', 'isNaN', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent',
  'structuredClone', 'queueMicrotask', 'atob', 'btoa',
  // node / electron / browser
  'require', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate',
  'process', 'console', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'fetch', 'AbortController', 'Notification', 'Audio', 'Image', 'Blob', 'FileReader',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'matchMedia', 'alert',
  'AudioContext', 'OfflineAudioContext', 'ResizeObserver', 'MutationObserver', 'CustomEvent',
  'Event', 'DOMParser', 'crypto', 'performance', 'localStorage', 'document', 'window', 'navigator',
  // ключевые слова, которые в тексте выглядят как вызов: `if (`, `switch (`, `catch (`…
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'new',
  'delete', 'void', 'do', 'else', 'try', 'throw', 'case', 'in', 'of', 'async', 'super', 'this',
  'yield', 'instanceof', 'let', 'const', 'var',
]);

// Комментарии, строковые литералы и РЕГУЛЯРКИ — вон. В них полно слов со скобкой: и русская проза
// в комментариях, и `--dangerously-skip-permissions(\s|$)` внутри регулярного выражения.
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\[\s\S]|\$\{[^{}]*\}|[^`\\])*`/g, '``')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    // регулярка: от `/` до `/` с флагами, но не деление — требуем перед ней «начало выражения»
    .replace(/([=(,:[!&|?{};+\s])\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuyv]*/g, '$1 RE ');
}

function declaredNames(src) {
  const out = new Set();
  const add = (n) => { if (n) out.add(n.trim()); };
  for (const m of src.matchAll(/function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // деструктуризация: const { a, b: c } = require(…)
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^{}]*)\}/g)) {
    for (const part of m[1].split(',')) add(part.split(':').pop().replace(/=.*/, ''));
  }
  // параметры: function f(a, b) {…}, (a, b) => …, a => …
  for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) add(part.replace(/[=.].*/, '').replace(/[{}[\]]/g, ''));
  }
  for (const m of src.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
  // методы объекта и класса: name(…) { — вызываются они через точку, но объявлены так
  for (const m of src.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gm)) add(m[1]);
  return out;
}

// Вызовы БЕЗ точки перед именем: `foo(` — это обращение к своей функции или к глобальной.
// `obj.foo(` нас не касается: методы объекта здесь не проверить.
function calledNames(src) {
  const out = new Map();
  for (const m of src.matchAll(/(^|[^.\w$?])([a-zA-Z_$][\w$]*)\s*\(/g)) {
    out.set(m[2], (out.get(m[2]) || 0) + 1);
  }
  return out;
}

// Что файл получает извне: глобальные, положенные соседними скриптами (renderer.js читает
// window.SWARM_*), и мост preload. Проверяем по факту наличия объявления в другом файле — иначе
// пришлось бы описывать эти связи вторым списком, который разойдётся с кодом.
function check(file, extraKnown) {
  const src = strip(fs.readFileSync(path.join(root, file), 'utf8'));
  const declared = declaredNames(src);
  const missing = [];
  for (const [name, times] of calledNames(src)) {
    if (declared.has(name) || KNOWN_GLOBALS.has(name) || extraKnown.has(name)) continue;
    missing.push(`${name}() ×${times}`);
  }
  return missing.sort();
}

test('main.js: каждая вызванная функция где-то объявлена', () => {
  assert.deepStrictEqual(check('main.js', new Set()), []);
});

test('renderer.js: то же самое', () => {
  // Рендерер зовёт функции, объявленные в соседних <script> (window.SWARM_*) — но по имени, без
  // точки, там ничего нет; и свои DOM-хелперы. Список пуст намеренно: если он понадобится,
  // значит появилась новая связь между файлами, и её стоит увидеть глазами.
  assert.deepStrictEqual(check('renderer/renderer.js', new Set()), []);
});

test('проверка вообще работает: подсунутый вызов несуществующей функции виден', () => {
  const src = strip('function real() { return 1; }\nreal();\nghostFunction();\n');
  const declared = declaredNames(src);
  const missing = [...calledNames(src).keys()].filter((n) => !declared.has(n) && !KNOWN_GLOBALS.has(n));
  assert.deepStrictEqual(missing, ['ghostFunction']);
});

test('и не срабатывает на прозе в комментариях и на регулярках', () => {
  const src = strip([
    '// правило (см. выше) и слово (тут)',
    '/* блок (со скобкой) */',
    'const re = /--dangerously-skip-permissions(\\s|$)/;',
    'const s = "текст (в строке)";',
    'function used() {}',
    'used();',
  ].join('\n'));
  const declared = declaredNames(src);
  const missing = [...calledNames(src).keys()].filter((n) => !declared.has(n) && !KNOWN_GLOBALS.has(n));
  assert.deepStrictEqual(missing, []);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; } catch (e) {
    console.error(`FAIL ${name}\n  ${e.message}`);
    process.exit(1);
  }
}
console.log(`undefined-calls: ${passed}/${tests.length} ok`);
