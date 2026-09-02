'use strict';
// cpu.js — чистая арифметика для значка загрузки CPU на карточке вкладки.
//
// Дерево процессов вкладки (шелл + агент + все его потомки) main.js уже обходит каждый тик
// scanTabProcesses (main.js) — тем же вызовом `ps`, которым ищет команду в шелле, только с
// добавленным полем `time=` (накопленное CPU-время процесса, `M+:SS.ss`). Здесь — только
// перевод этого поля в проценты между двумя тиками и решение, красить ли и как. Само чтение
// `ps` и обход дерева — в main.js: это нельзя проверить тестом дёшево, а то, что здесь, можно.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_CPU = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Ниже порога — значка нет: единицы процентов у идущего разговора есть всегда (сам
  // терминал, детектор экрана), и держать значок вечно видимым обесценивало бы его как
  // сигнал «тут прямо сейчас жарко». Дальше — три оттенка, как у полоски контекста
  // (styles.css: ctx-lo/mid/hi), но с другими порогами: тут можно больше 100% — деревом
  // считаем несколько ядер сразу (агент + сабагенты), и 150% — это уже весь процессор занят.
  const HIDE_BELOW = 15;
  const MID_AT = 70;
  const HI_AT = 150;

  // 'M+:SS.ss' → CPU-секунды. Минуты не ограничены (у долгоживущего процесса запросто
  // четырёхзначные), поэтому не (\d{1,2}) а (\d+).
  const TIME_RE = /^(\d+):(\d+(?:\.\d+)?)$/;
  function cpuSecondsFromTime(str) {
    const m = TIME_RE.exec(String(str || '').trim());
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  // Процент между двумя снимками одного дерева процессов. prevCs/currCs — сумма CPU-секунд
  // по дереву, prevTs/currTs — время снимков (ms, Date.now()). CPU-секунды процесса не
  // убывают, но дерево между тиками могло смениться (процесс вышел, другой пришёл на его
  // место) — поэтому отрицательную дельту не считаем провалом в минус, а просто нулём.
  function cpuPctFromDelta(prevCs, currCs, prevTs, currTs) {
    const dtMs = currTs - prevTs;
    if (!(dtMs > 0) || !isFinite(prevCs) || !isFinite(currCs)) return null;
    const diffS = Math.max(0, currCs - prevCs);
    return (diffS * 1000 / dtMs) * 100;
  }

  function cpuTier(pct) {
    if (pct == null || !isFinite(pct) || pct < HIDE_BELOW) return null;
    if (pct < MID_AT) return 'lo';
    if (pct < HI_AT) return 'mid';
    return 'hi';
  }

  // Что показать на значке: тир решает цвет и видимость разом, чтобы вызывающему не
  // сверять их отдельно и не рассинхронить.
  function formatCpuBadge(pct) {
    const tier = cpuTier(pct);
    if (!tier) return { hidden: true, tier: null, text: '' };
    return { hidden: false, tier, text: Math.round(pct) + '%' };
  }

  return { HIDE_BELOW, MID_AT, HI_AT, cpuSecondsFromTime, cpuPctFromDelta, cpuTier, formatCpuBadge };
});
