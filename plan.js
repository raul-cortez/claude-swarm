// plan.js — разбор раздела «## План» файла работы вкладки в дерево шагов.
// Dual-mode: module.exports под Node (main, тест). Только строки, без файловой системы и DOM.
// Формат: пункты с отметкой `[ ]` не сделано, `[x]`/`[X]` сделано, `[>]` мы здесь;
// подшаги вложены отступом.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_PLAN = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const MARK = /^(\s*)(?:[-*+]\s+)?\[([ xX>])\]\s*(.*)$/;

  // Текст раздела «## План» (до следующего заголовка того же или верхнего уровня).
  function section(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let on = false;
    for (const line of lines) {
      const h = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
      if (h) {
        if (on && h[1].length <= 2) break;
        if (!on && h[1].length === 2 && h[2].toLowerCase() === 'план') { on = true; continue; }
      }
      if (on) out.push(line);
    }
    return out.join('\n').replace(/<!--[\s\S]*?-->/g, '');
  }

  function indentOf(s) { return s.replace(/\t/g, '    ').length; }

  // Дерево: [{text, state: 'done'|'todo'|'now', children}]. Пункт без отметки (комментарий,
  // пояснение) в дерево не попадает.
  function parseTree(text) {
    const roots = [];
    const stack = [];
    for (const line of section(text).split('\n')) {
      const m = MARK.exec(line);
      if (!m) continue;
      const depth = indentOf(m[1]);
      const label = m[3].trim();
      if (!label) continue;
      const node = { text: label, state: m[2] === '>' ? 'now' : m[2] === ' ' ? 'todo' : 'done', children: [] };
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
      if (stack.length) stack[stack.length - 1].node.children.push(node);
      else roots.push(node);
      stack.push({ depth, node });
    }
    return roots;
  }

  function flatten(nodes, acc) {
    for (const n of nodes) { acc.push(n); flatten(n.children, acc); }
    return acc;
  }

  // «План есть» = не меньше двух размеченных строк в разделе, на любой глубине.
  // Возвращает {tree, done, total, nowIndex} или null. done/total — по верхним шагам;
  // nowIndex — индекс верхнего шага, где мы: первый с `[>]` (сам или в потомках), иначе
  // первый незакрытый, иначе -1.
  function parse(text) {
    const tree = parseTree(text);
    if (flatten(tree, []).length < 2) return null;
    const hasNow = (n) => n.state === 'now' || n.children.some(hasNow);
    const done = tree.filter((n) => n.state === 'done').length;
    let nowIndex = tree.findIndex(hasNow);
    if (nowIndex < 0) nowIndex = tree.findIndex((n) => n.state !== 'done');
    return { tree, done, total: tree.length, nowIndex };
  }

  return { parse, parseTree, section };
});
