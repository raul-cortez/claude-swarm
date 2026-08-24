// Контрактный тест верхнего уровня: код, случайно положенный МИМО функции, ломает файл целиком,
// а тестами логики этого не видно.
//
// Живой случай, ради которого тест и написан: правка сводки заехала не в тело окна, а в НАЧАЛО
// renderer.js — семьдесят одна строка на верхнем уровне, где нет ни `overlay`, ни `dg`. Синтаксис
// целый, `node --check` молчит, весь набор тестов зелёный — а окно приложения не открывается
// вовсе: первая же строка бросает ReferenceError, и файл обрывается со всеми слушателями. Ловится
// это только запуском приложения, то есть глазами человека.
//
// Признак у такой ошибки простой и надёжный: строка стоит С ОТСТУПОМ при НУЛЕВОЙ глубине скобок.
// Настоящий верхний уровень в этом проекте начинается с первой колонки; отступ на нуле бывает
// только у продолжения начатой строки (тело стрелки, тернарник в две строки) — его и исключаем
// по прошлой строке.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const root = path.join(__dirname, '..');
const FILES = [
  'main.js', 'preload.js', 'night.js', 'telegram.js', 'detector.js', 'screen.js', 'restart.js',
  'transcript.js', 'unread.js', 'ask-phrases.js', 'updater.js', 'updater-core.js', 'voice.js',
  'md.js', 'git.js', 'osc.js', 'pty-write.js', 'pty-loader.js', 'agent-rules.js', 'launch-line.js',
  'renderer/renderer.js', 'renderer/diffview.js', 'renderer/themes.js', 'renderer/tabstyle.js',
  'renderer/keybinds.js', 'renderer/logstore.js', 'renderer/resume.js', 'renderer/launch-word.js',
  'renderer/termtalk.js',
];

// Выкусываем всё, где скобки не считаются: комментарии, строки, шаблоны и РЕГУЛЯРКИ. Последние
// обязательны — `/\x1b\]777;/` роняет наивный счётчик в минус, и тело следующей функции
// выглядит верхним уровнем.
function strip(src) {
  let out = '';
  let i = 0;
  let quote = null;
  let inRe = false;
  let inClass = false;
  const prevMeaning = () => {
    for (let k = out.length - 1; k >= 0; k--) {
      const c = out[k];
      if (c === ' ' || c === '\t' || c === '\n') continue;
      return c;
    }
    return '';
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) { quote = null; i++; continue; }
      if (c === '\n') out += '\n';
      i++;
      continue;
    }
    if (inRe) {
      if (c === '\\') { i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { inRe = false; i++; continue; }
      else if (c === '\n') { inRe = false; out += '\n'; i++; continue; }   // незакрытая — не регулярка
      i++;
      continue;
    }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += ' '; i++; continue; }
    // Регулярка или деление — решает то, что стоит ПЕРЕД слэшем: после значения это деление,
    // после оператора или открывающей скобки — литерал.
    if (c === '/' && '=(,:[!&|?{};+-*%~^'.includes(prevMeaning() || '(')) { inRe = true; out += ' '; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

function orphans(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const raw = src.split('\n');
  const clean = strip(src).split('\n');
  const out = [];
  let depth = 0;
  for (let i = 0; i < clean.length; i++) {
    const before = depth;
    for (const ch of clean[i]) {
      if (ch === '{' || ch === '(' || ch === '[') depth++;
      else if (ch === '}' || ch === ')' || ch === ']') depth--;
    }
    if (before !== 0 || !clean[i].trim() || !/^[ \t]/.test(raw[i])) continue;
    let prev = '';
    for (let k = i - 1; k >= 0; k--) { if (clean[k].trim()) { prev = clean[k].trim(); break; } }
    if (prev && !/[;{}]$/.test(prev)) continue;      // продолжение начатой строки — законно
    out.push(`${file}:${i + 1}  ${raw[i].trim().slice(0, 70)}`);
  }
  return out;
}

test('на верхнем уровне файлов нет осиротевшего кода', () => {
  const bad = [];
  for (const f of FILES) bad.push(...orphans(f));
  assert.deepStrictEqual(bad, [], 'код с отступом при нулевой глубине скобок:\n' + bad.join('\n'));
});

// Тест обязан ЛОВИТЬ ту самую беду, иначе он украшение. Проверяем на подделке: берём начало
// настоящего файла и подсовываем перед ним кусок из тела функции.
test('подделка с осиротевшим блоком ловится', () => {
  const tmp = path.join(require('os').tmpdir(), 'swarm-orphan-' + process.pid + '.js');
  fs.writeFileSync(tmp, [
    "  const body = overlay.querySelector('.night-body');",
    '  for (const c of ((dg && dg.tabs) || [])) {',
    '    body.appendChild(c);',
    '  }',
    '// файл.js — настоящая шапка',
    "const x = 1;",
    'function f() {',
    '  return x;',
    '}',
  ].join('\n'));
  const before = FILES.length;
  const found = (() => {
    const src = fs.readFileSync(tmp, 'utf8');
    const raw = src.split('\n');
    const clean = strip(src).split('\n');
    const out = [];
    let depth = 0;
    for (let i = 0; i < clean.length; i++) {
      const b = depth;
      for (const ch of clean[i]) {
        if (ch === '{' || ch === '(' || ch === '[') depth++;
        else if (ch === '}' || ch === ')' || ch === ']') depth--;
      }
      if (b !== 0 || !clean[i].trim() || !/^[ \t]/.test(raw[i])) continue;
      let prev = '';
      for (let k = i - 1; k >= 0; k--) { if (clean[k].trim()) { prev = clean[k].trim(); break; } }
      if (prev && !/[;{}]$/.test(prev)) continue;
      out.push(i + 1);
    }
    return out;
  })();
  fs.rmSync(tmp, { force: true });
  assert.strictEqual(before, FILES.length);
  assert.ok(found.includes(1), 'осиротевшая первая строка должна быть найдена, найдено: ' + found.join(','));
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\ntoplevel: ${passed}/${tests.length} ok`);
})();
