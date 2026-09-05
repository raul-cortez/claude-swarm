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
  // Проценты — от ВСЕЙ машины: 100% значит «занят весь процессор», а не «занято одно ядро».
  // По ядру считать бессмысленно для сигнала «тут прямо сейчас жарко»: одно занятое ядро на
  // 4-ядерном ноутбуке и на 16-ядерной станции — совсем разная новость, а число выходило одно.
  //
  // Тиров два, не три, и спокойного зелёного среди них нет намеренно. Значок отвечает на один
  // вопрос — «какие вкладки жёстко грузят машину»; пока у него была нижняя зелёная ступень, он
  // висел почти на каждой живой вкладке и этим ничего не сообщал. Поэтому ниже HIDE_BELOW
  // значка нет вовсе, а всё, что видно, — уже заметная нагрузка: 'mid' (var(--run)) и от
  // HI_AT — 'hi' (var(--danger)), половина машины на одной вкладке.
  const HIDE_BELOW = 25;
  const HI_AT = 50;

  // 'M+:SS.ss' → CPU-секунды. Минуты не ограничены (у долгоживущего процесса запросто
  // четырёхзначные), поэтому не (\d{1,2}) а (\d+).
  const TIME_RE = /^(\d+):(\d+(?:\.\d+)?)$/;
  function cpuSecondsFromTime(str) {
    const m = TIME_RE.exec(String(str || '').trim());
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  // Процент между двумя снимками одного дерева процессов. prevCs/currCs — сумма CPU-секунд
  // по дереву, prevTs/currTs — время снимков (ms, Date.now()), cores — сколько ядер у машины
  // (os.cpus().length у зовущего; мусор и ноль читаем как 1, чтобы не делить на пустоту и не
  // выдать Infinity). CPU-секунды процесса не убывают, но дерево между тиками могло смениться
  // (процесс вышел, другой пришёл на его место) — поэтому отрицательную дельту не считаем
  // провалом в минус, а просто нулём.
  function cpuPctFromDelta(prevCs, currCs, prevTs, currTs, cores) {
    const dtMs = currTs - prevTs;
    if (!(dtMs > 0) || !isFinite(prevCs) || !isFinite(currCs)) return null;
    const n = isFinite(cores) && cores >= 1 ? cores : 1;
    const diffS = Math.max(0, currCs - prevCs);
    return (diffS * 1000 / dtMs) * 100 / n;
  }

  function cpuTier(pct) {
    if (pct == null || !isFinite(pct) || pct < HIDE_BELOW) return null;
    return pct < HI_AT ? 'mid' : 'hi';
  }

  // Что показать на значке: тир решает цвет и видимость разом, чтобы вызывающему не
  // сверять их отдельно и не рассинхронить. Больше 100% быть не может — считаем от всей
  // машины, — но округление вверх на границе прижимаем, чтобы не мелькало «101%».
  function formatCpuBadge(pct) {
    const tier = cpuTier(pct);
    if (!tier) return { hidden: true, tier: null, text: '' };
    return { hidden: false, tier, text: Math.min(100, Math.round(pct)) + '%' };
  }

  return { HIDE_BELOW, HI_AT, cpuSecondsFromTime, cpuPctFromDelta, cpuTier, formatCpuBadge };
});
