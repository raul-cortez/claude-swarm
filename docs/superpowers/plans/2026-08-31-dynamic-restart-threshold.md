# Динамический порог перезапуска — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить плоский порог самоперезапуска (один `%` окна на все проекты) на порог,
который система считает сама из того, во сколько раз контекст сессии вырос от её собственного
старта — без новой настройки в UI.

**Architecture:** Чистая формула живёт в `restart.js` (`effectivePct(baselinePct, mult)`,
уже под юнит-тестами). `main.js` один раз за сессию измеряет `baselinePct` (первый валидный
снимок контекста после старта/рестарта вкладки) и передаёт его в автомат вместо прежнего
`threshold`. `renderer.js` и `index.html` теряют ползунок настройки — крутить больше нечего.
`MANUAL.md` и один комментарий в `digest.js` подчищаются вслед за исчезнувшим API.

**Tech Stack:** Node.js (CommonJS, без сборки), Electron main/renderer/preload, юнит-тесты —
самодельный раннер без фреймворка (`node test/<name>.test.js`, без testing-библиотек).

Спека: `docs/superpowers/specs/2026-08-31-dynamic-restart-threshold-design.md`.

---

### Task 1: `restart.js` — формула `effectivePct` вместо плоского порога

**Files:**
- Modify: `restart.js:18-39` (константы + `clampPct`), `restart.js:337-342` (`pctOver`),
  `restart.js:796-808` (экспорты)
- Test: `test/restart.test.js`

- [ ] **Step 1: Переписать тесты под новый API**

  В `test/restart.test.js` убрать `OPTS` (использует несуществующий теперь `threshold`, и без
  того нигде не читается):

  ```js
  // было (строка 17):
  const OPTS = { enabled: true, threshold: 30, now: 1000 + HOUR };

  // стало: строку убрать целиком (следующая пустая строка перед test(...) остаётся)
  ```

  Заменить тест `'порог зажат диапазоном 15–75'` (строки 19-27) и
  `'незаданный порог — это умолчание, а не ноль'` (строки 29-38) на тесты `effectivePct`:

  ```js
  test('effectivePct зажат диапазоном 15–75', () => {
    assert.strictEqual(R.effectivePct(1, 7), 15, 'совсем лёгкий проект — упирается в пол');
    assert.strictEqual(R.effectivePct(5, 7), 35);
    assert.strictEqual(R.effectivePct(20, 7), 75, 'совсем тяжёлый проект — упирается в потолок');
  });

  // Раньше "не задано" тихо превращалось в самый агрессивный порог (Number(null) === 0, а 0 —
  // законное значение ползунка) — новый человек получал бы перезапуски вдвое чаще обещанного,
  // молча. Здесь цена такой же тихой подмены выше: пришлось бы решать "пора спрашивать" на
  // вкладке, у которой ещё не было ни одного снимка контекста. Поэтому — null, а не умолчание.
  test('effectivePct без известного baseline — null, а не умолчание', () => {
    assert.strictEqual(R.effectivePct(null, 7), null);
    assert.strictEqual(R.effectivePct(undefined, 7), null);
    assert.strictEqual(R.effectivePct(0, 7), null);
    assert.strictEqual(R.effectivePct(-5, 7), null);
    assert.strictEqual(R.effectivePct('нет', 7), null);
  });

  test('effectivePct берёт множитель по умолчанию, если свой не передали', () => {
    assert.strictEqual(R.effectivePct(5), R.effectivePct(5, R.DEFAULT_MULT));
    assert.strictEqual(R.effectivePct(5, 0), R.effectivePct(5, R.DEFAULT_MULT), 'нулевой множитель — тоже не задан');
  });
  ```

  В `sig()` (строка 46-52) заменить `threshold: 30` на `baselinePct: 5` (5×7=35 — тот же смысл
  «дефолтный `pct: 40` за порогом», что раньше давал `threshold: 30`):

  ```js
  const NOW = 10 * HOUR;
  // baselinePct: 5 → эффективный порог 5×7=35 (клампы 15/75 не задействованы) — дефолтный
  // pct: 40 из sig() по-прежнему "за порогом", как раньше при threshold: 30.
  function sig(over) {
    return {
      now: NOW, enabled: true, baselinePct: 5, pct: 40, status: 'ready',
      dialog: false, shellBusy: true, modeVisible: true, uptimeMs: HOUR,
      hasBase: true, hasLine: false, answer: null, ...over,
    };
  }
  ```

  В тесте `'ниже порога, при выключенной функции и в немоте — молчим'` (строки 63-68) заменить
  `{ pct: 40, threshold: 75 }` на `{ pct: 40, baselinePct: 20 }` (тяжёлый baseline: 20×7=140,
  зажато потолком 75 — тот же смысл «порог заведомо выше pct»):

  ```js
  test('ниже порога, при выключенной функции и в немоте — молчим', () => {
    assert.strictEqual(step(idle(), { pct: 29 }).action, 'nothing');
    assert.strictEqual(step(idle(), { enabled: false }).action, 'nothing');
    assert.strictEqual(step(idle(), { pct: 40, baselinePct: 20 }).action, 'nothing');
    assert.strictEqual(R.step({ ...idle(), phase: 'muted' }, sig()).action, 'nothing');
  });

  // Новое покрытие: лёгкий проект должен получать вопрос РАНЬШЕ, чем при плоских 30% —
  // ровно то, ради чего формула и переделана (см. спеку).
  test('лёгкий baseline двигает порог ниже — спрашиваем раньше плоских 30%', () => {
    // baseline 3×7=21: pct=25 при плоском пороге 30% "за порогом" не считался бы, теперь считается.
    assert.strictEqual(step(idle(), { pct: 25, baselinePct: 3 }).action, 'ask');
  });

  test('baseline ещё не измерен — не спрашиваем, даже если pct высокий', () => {
    for (const baselinePct of [null, undefined, 0, -1]) {
      assert.strictEqual(step(idle(), { pct: 90, baselinePct }).action, 'nothing');
    }
  });
  ```

  В тесте `'зов файлом работает и до порога, и на молодой вкладке'` (строка 212) заменить
  `{ threshold: 75 }` на `{ baselinePct: 20 }` в списке `over`:

  ```js
  for (const over of [{ pct: 20 }, { pct: 0 }, { uptimeMs: 60_000 }, { baselinePct: 20 }]) {
  ```

- [ ] **Step 2: Убедиться, что тесты падают на старом `restart.js`**

  Run: `node test/restart.test.js`
  Expected: FAIL — `R.effectivePct is not a function` (или `TypeError`) на первом же новом тесте.

- [ ] **Step 3: Переписать константы и `clampPct` → `effectivePct` в `restart.js`**

  Заменить блок строк 18-39 (`MIN_PCT`/`MAX_PCT`/`DEFAULT_PCT` + `clampPct` с комментариями):

  ```js
  // Эффективный порог для ЭТОЙ сессии — не абсолютный процент окна, а во сколько раз контекст
  // вырос от того, с чем сессия стартовала. Тяжёлый проект (свой CLAUDE.md, большая память)
  // стартует уже на заметном проценте — плоский порог спрашивал бы его почти сразу, ничего не
  // сделав; лёгкий стартует дёшево — тот же плоский порог держит его до последнего, хотя работы
  // уже накопилось много. Спека:
  // docs/superpowers/specs/2026-08-31-dynamic-restart-threshold-design.md
  const MIN_PCT = 15;
  const MAX_PCT = 75;
  const DEFAULT_MULT = 7;

  // baselinePct — то же самое число, что и текущий pct (ctxUsed), снятое на первом ходу сессии:
  // main.js фиксирует его один раз и не трогает до следующего рестарта (см. d.baselinePct).
  // Если снимка ещё не было — null, и это не «умолчание», а «рано решать»: раньше пустая
  // настройка тихо превращалась в самый агрессивный порог (Number(null) === 0, законное
  // значение ползунка) — здесь тихая подмена была бы опаснее: молчаливое «пора спрашивать» на
  // вкладке, которая не сделала ни хода.
  //
  // MIN_PCT/MAX_PCT остались от старого ползунка, но роль сменили: не диапазон настройки, а
  // предохранители формулы — снизу защёлка от вкладки, которая ничего не сделала, сверху —
  // гарантия спросить раньше автосжатия при любом baseline.
  function effectivePct(baselinePct, mult) {
    const b = Number(baselinePct);
    if (!isFinite(b) || b <= 0) return null;
    const m = Number(mult);
    const mm = isFinite(m) && m > 0 ? m : DEFAULT_MULT;
    return Math.max(MIN_PCT, Math.min(MAX_PCT, b * mm));
  }
  ```

  Заменить `pctOver` (строки 337-342):

  ```js
  // Перейдён ли порог — то есть пора ли СПРАШИВАТЬ. К зову файлом отношения не имеет.
  function pctOver(s) {
    const pct = Number(s.pct);
    if (!isFinite(pct) || pct <= 0) return false;      // расхода нет — статуслайн молчит
    const threshold = effectivePct(s.baselinePct, s.mult);
    if (threshold == null) return false;                // baseline ещё не измерен — рано решать
    return pct >= threshold;
  }
  ```

  В блоке экспортов (строки 796-803) заменить `DEFAULT_PCT` на `DEFAULT_MULT` и `clampPct` на
  `effectivePct`:

  ```js
  return {
    MIN_PCT, MAX_PCT, DEFAULT_MULT, MIN_UPTIME_MS, RETRY_MS, ANSWER_WAIT_MS,
    MAX_SILENT, PENDING_MS, EXIT_BLIND_MS, GONE_GAP_MS, GRANT_WAIT_MS, GRANT_CALM_MS, RETRY_MIN_MS,
    PROMPT_MAX, PROMPT_CARRIED,
    effectivePct, initial, step, wantsAnswer, goneStep, askText, askAgainText, parseAnswer, retryMsOf, quoteArg, launchLine,
    answerName,
    promptFits, handoffPrompt,
    turnOver,
    holdText,
  };
  ```

- [ ] **Step 4: Прогнать тесты — все зелёные**

  Run: `node test/restart.test.js`
  Expected: `restart: N/N ok` (N — новое общее число тестов, старое минус 2 плюс 5).

- [ ] **Step 5: Commit**

  ```bash
  git add restart.js test/restart.test.js
  git commit -m "$(cat <<'EOF'
  feat(restart): порог перезапуска — множитель от старта сессии, не флэт %

  effectivePct(baselinePct, mult) заменяет clampPct/DEFAULT_PCT: спрашиваем не когда
  контекст занял X% окна (одинаково для всех проектов), а когда вырос в N раз от того,
  с чем эта сессия стартовала. См. docs/superpowers/specs/2026-08-31-dynamic-restart-threshold-design.md.

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01XPq7ZvuYeCJaM74BwpXpeo
  EOF
  )"
  ```

---

### Task 2: `main.js` — измерение `baselinePct` и передача его в автомат

**Files:**
- Modify: `main.js:5389-5390`, `main.js:5773-5827` (`restartTick`), `main.js:6061-6118`
  (`restartFire`), `main.js:6437-6454` (создание вкладки), `main.js:6343-6347`
  (`settings:restart`)

У `restart.js` нет автоматических тестов на `main.js` — эта часть под контролем только
контрактных тестов (`undefined-calls`, `dom-ids`) и ручного чтения диффа; отдельного шага
«написать тест» здесь нет, потому что для main.js в проекте такого прецедента нет ни у одной
из существующих веток restartTick/restartFire.

- [ ] **Step 1: Убрать `RESTART_PCT`**

  ```js
  // было (main.js:5389-5390):
  let RESTART_ENABLED = false;
  let RESTART_PCT = restart.DEFAULT_PCT;

  // стало:
  let RESTART_ENABLED = false;
  ```

- [ ] **Step 2: Измерять `baselinePct` в `restartTick` и передавать его вместо `threshold`**

  ```js
  // было (main.js:5780-5796):
  const byPid = state.phase === 'exiting' && d.rsSignalled && d.rsShellBusy !== undefined;
  const pct = byPid ? 0 : restartPctOf(d, now);
  // ...
  const r = restart.step(state, {
    now,
    enabled: RESTART_ENABLED,
    threshold: RESTART_PCT,
    pct,
    status: d.status,

  // стало:
  const byPid = state.phase === 'exiting' && d.rsSignalled && d.rsShellBusy !== undefined;
  const pct = byPid ? 0 : restartPctOf(d, now);
  // Стартовый размер контекста ЭТОЙ сессии — первое валидное число после её рождения
  // (d.sessionStartAt, сбрасывается там же, где и оно — см. restartFire и создание вкладки).
  // Фиксируем один раз и не трогаем до следующего рестарта. Байпасный путь (byPid) — не
  // настоящий снимок расхода, в baseline его не берём.
  if (!byPid && d.baselinePct == null && pct > 0) d.baselinePct = pct;
  const r = restart.step(state, {
    now,
    enabled: RESTART_ENABLED,
    baselinePct: d.baselinePct,
    pct,
    status: d.status,
  ```

  (Остальные поля объекта, передаваемого в `restart.step`, — `bg`, `dialog`, `kind`, `box`,
  `sub`, `shellBusy`, `modeVisible`, `uptimeMs`, `hasLine`, `hasBase`, `answer` — не трогать.)

- [ ] **Step 3: Сбрасывать `baselinePct` вместе с `sessionStartAt`**

  В `restartFire` (место, где стартует свежая сессия после исполненного разрешения):

  ```js
  // было (main.js:6118):
  d.sessionStartAt = Date.now();

  // стало:
  d.sessionStartAt = Date.now();
  d.baselinePct = null;
  ```

  В обработчике создания вкладки (`ipcMain.handle`/аналог, где вкладка стартует впервые):

  ```js
  // было (main.js:6454):
  d0.sessionStartAt = Date.now();

  // стало:
  d0.sessionStartAt = Date.now();
  d0.baselinePct = null;
  ```

  (Явный сброс здесь не обязателен по факту — у нового объекта `d0.baselinePct` и так
  `undefined`, а `== null` в Step 2 это ловит, — но пишем рядом с `sessionStartAt` явно: так
  видно, что это одна пара сброса, а не забытое поле.)

- [ ] **Step 4: Убрать `threshold` из обработчика настройки**

  ```js
  // было (main.js:6343-6347):
  ipcMain.on('settings:restart', (_e, opts = {}) => {
    const was = RESTART_ENABLED;
    RESTART_ENABLED = !!(opts && opts.enabled);
    RESTART_PCT = restart.clampPct(opts && opts.threshold);
    restartLog(`настройка: ${RESTART_ENABLED ? 'вкл' : 'выкл'}, порог ${RESTART_PCT}%`);

  // стало:
  ipcMain.on('settings:restart', (_e, opts = {}) => {
    const was = RESTART_ENABLED;
    RESTART_ENABLED = !!(opts && opts.enabled);
    restartLog(`настройка: перезапуск ${RESTART_ENABLED ? 'вкл' : 'выкл'}`);
  ```

- [ ] **Step 5: Прогнать контрактные тесты**

  Run: `node test/undefined-calls.test.js && node test/toplevel.test.js`
  Expected: оба `ok` — `RESTART_PCT` нигде не остался вызванным/объявленным без пары.

  Дополнительно: `grep -n "RESTART_PCT\|restart.clampPct\|restart.DEFAULT_PCT" main.js` — пусто.

- [ ] **Step 6: Commit**

  ```bash
  git add main.js
  git commit -m "$(cat <<'EOF'
  feat(restart): main.js меряет baselinePct сессии вместо чтения настройки порога

  Первый валидный снимок контекста после старта/рестарта вкладки фиксируется как её
  baseline и живёт до следующего рестарта — тем же способом, каким уже отслеживается
  d.sessionStartAt. RESTART_PCT/threshold из настроек убраны.

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01XPq7ZvuYeCJaM74BwpXpeo
  EOF
  )"
  ```

---

### Task 3: `renderer.js` + `index.html` — убрать ползунок настройки

**Files:**
- Modify: `renderer/index.html:170-172`
- Modify: `renderer/renderer.js:134`, `renderer/renderer.js:775-781`,
  `renderer/renderer.js:1567-1594`, `renderer/renderer.js:2304-2324`,
  `renderer/renderer.js:3393-3400`, `renderer/renderer.js:6054`

- [ ] **Step 1: Убрать `<script src="../restart.js">` и его комментарий**

  ```html
  <!-- было (renderer/index.html:170-172): -->
  <!-- Самоперезапуск вкладки (window.SWARM_RESTART). Общий с main: границы ползунка в
       настройках и порог, по которому main спрашивает агента, — одно и то же число. -->
  <script src="../restart.js"></script>

  <!-- стало: обе строки убрать целиком -->
  ```

- [ ] **Step 2: Убрать HTML-разметку ползунка**

  ```html
  <!-- было (renderer/renderer.js:1580-1594, шаблонная строка панели настроек): -->
              <div class="set-sub">
                <div class="set-field is-row">
                  <div class="set-head">
                    <span class="set-label">Спрашивать при заполнении</span>
                    <button type="button" class="set-q" aria-label="подсказка">?</button>
                    <span class="set-hint" hidden>То же число, что на полоске контекста вкладки. Считается от точки
                      автосжатия: на 100% Клод сжимает разговор сам, так что позже нас уже поздно. Левее — чаще
                      перезапуски, агент свежее. Правее — реже, одна сессия живёт дольше.</span>
                  </div>
                  <div class="set-range">
                    <input type="range" class="set-range-input" id="set-restart-pct" />
                    <span class="set-range-num" id="set-restart-pct-num"></span>
                  </div>
                </div>
              </div>

  <!-- стало: блок убрать целиком -->
  ```

  Рядом (строки 1573-1578) обновить текст подсказки у самой галочки — добавить одно
  предложение про то, что порог теперь считается сам:

  ```html
  <!-- было: -->
              <span class="set-hint" hidden>Агент тупеет задолго до конца окна, а сам себя почистить не может.
                Спросим его, можно ли сейчас: он зафиксирует эстафету — записку себе будущему — и мы стартуем
                свежую сессию в этой же вкладке, с её задачей. Решает он: пока стоит на середине работы, отвечает
                «не сейчас». Нужна наша строка статуса — из неё берётся заполнение контекста. А если перезапуск
                нужен прямо сейчас, его зовут файлом <span class="set-mono">.swarm-restart.json</span> в папке
                вкладки — как он устроен, написано в инструкции.</span>

  <!-- стало: -->
              <span class="set-hint" hidden>Агент тупеет задолго до конца окна, а сам себя почистить не может.
                Спросим его, можно ли сейчас: он зафиксирует эстафету — записку себе будущему — и мы стартуем
                свежую сессию в этой же вкладке, с её задачей. Решает он: пока стоит на середине работы, отвечает
                «не сейчас». Нужна наша строка статуса — из неё берётся заполнение контекста. Порог, при котором
                мы спросим, сворм считает сам — по тому, насколько контекст вырос от старта именно этой вкладки,
                для каждого проекта свой. А если перезапуск нужен прямо сейчас, его зовут файлом
                <span class="set-mono">.swarm-restart.json</span> в папке вкладки — как он устроен, написано в
                инструкции.</span>
  ```

- [ ] **Step 3: Убрать чтение сохранённого порога и `RESTART_API`**

  ```js
  // было (renderer/renderer.js:134):
  const RESTART_API = window.SWARM_RESTART;     // самоперезапуск: границы порога, общие с main

  // стало: строку убрать целиком (после Step 1 window.SWARM_RESTART больше не появляется)
  ```

  ```js
  // было (renderer/renderer.js:776-781):
  // «Перезапускать агента, когда контекст заполнится» (Settings → Запуск). Выключено по
  // умолчанию: функция сама решает, когда стереть разговор, и включать такое за человека нельзя.
  // Порог — в процентах с полоски контекста, то есть отмеренных от точки автосжатия. Логика вся
  // в restart.js, здесь только память о выборе.
  let restartOn = localStorage.getItem('swarm.restart') === '1';
  let restartPct = RESTART_API.clampPct(localStorage.getItem('swarm.restartPct'));

  // стало:
  // «Перезапускать агента, когда контекст заполнится» (Settings → Запуск). Выключено по
  // умолчанию: функция сама решает, когда стереть разговор, и включать такое за человека нельзя.
  // Порог считает сам сворм — по тому, во сколько раз контекст вырос от старта конкретной
  // вкладки (restart.js), крутить здесь нечего.
  let restartOn = localStorage.getItem('swarm.restart') === '1';
  ```

- [ ] **Step 4: Убрать вкладку ползунка из инициализации панели настроек**

  ```js
  // было (renderer/renderer.js:2304-2324):
  // Самоперезапуск: галочка и порог. Границы ползунка приходят из restart.js — того же
  // модуля, по которому main решает «пора спросить», иначе панель обещала бы порог, с
  // которым перезапуск не работает.
  const restartI = overlay.querySelector('#set-restart');
  restartI.checked = restartOn;
  const restartPctI = overlay.querySelector('#set-restart-pct');
  const restartNumEl = overlay.querySelector('#set-restart-pct-num');
  restartPctI.min = String(RESTART_API.MIN_PCT);
  restartPctI.max = String(RESTART_API.MAX_PCT);
  restartPctI.step = '5';
  restartPctI.value = String(restartPct);
  const syncRestart = () => {
    restartNumEl.textContent = restartPctI.value + '%';
    // Выключенная функция не должна выглядеть настраиваемой: серый ползунок объясняет
    // порядок действий сам, без подписи «сначала включите».
    restartPctI.disabled = !restartI.checked;
    restartNumEl.classList.toggle('off', !restartI.checked);
  };
  restartPctI.addEventListener('input', syncRestart);
  restartI.addEventListener('change', syncRestart);
  syncRestart();

  // стало:
  // Самоперезапуск: одна галочка. Порог больше не настройка — сворм считает его сам по
  // старту конкретной вкладки (restart.js), крутить нечего.
  const restartI = overlay.querySelector('#set-restart');
  restartI.checked = restartOn;
  ```

- [ ] **Step 5: Убрать порог из обработчика сохранения настроек**

  ```js
  // было (renderer/renderer.js:3393-3400):
  const nextRestartPct = RESTART_API.clampPct(restartPctI.value);
  if (restartI.checked !== restartOn || nextRestartPct !== restartPct) {
    restartOn = restartI.checked;
    restartPct = nextRestartPct;
    localStorage.setItem('swarm.restart', restartOn ? '1' : '0');
    localStorage.setItem('swarm.restartPct', String(restartPct));
    window.swarm.setRestart({ enabled: restartOn, threshold: restartPct });
  }

  // стало:
  if (restartI.checked !== restartOn) {
    restartOn = restartI.checked;
    localStorage.setItem('swarm.restart', restartOn ? '1' : '0');
    window.swarm.setRestart({ enabled: restartOn });
  }
  ```

- [ ] **Step 6: Убрать порог из вызова при старте приложения**

  ```js
  // было (renderer/renderer.js:6054):
  window.swarm.setRestart({ enabled: restartOn, threshold: restartPct }); // порог самоперезапуска

  // стало:
  window.swarm.setRestart({ enabled: restartOn }); // порог теперь считает сам сворм, по старту вкладки
  ```

- [ ] **Step 7: Прогнать контрактные тесты разметки и вызовов**

  Run: `node test/dom-ids.test.js && node test/undefined-calls.test.js && node test/preload-contract.test.js`
  Expected: все три `ok` — `#set-restart-pct`/`#set-restart-pct-num` нигде не запрашиваются,
  `syncRestart`/`restartPctI`/`restartNumEl`/`RESTART_API` нигде не остались висящими вызовами.

  Дополнительно: `grep -n "restartPct\|RESTART_API\|set-restart-pct" renderer/renderer.js renderer/index.html`
  — пусто.

- [ ] **Step 8: Commit**

  ```bash
  git add renderer/renderer.js renderer/index.html
  git commit -m "$(cat <<'EOF'
  feat(restart): убрать ползунок порога из настроек — считается автоматически

  Порог перестал быть числом, которое можно выставить одинаковым на все проекты
  (см. docs/superpowers/specs/2026-08-31-dynamic-restart-threshold-design.md).
  Остаётся один тумблер «перезапускать агента, когда контекст заполнится».

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01XPq7ZvuYeCJaM74BwpXpeo
  EOF
  )"
  ```

---

### Task 4: Документация — `MANUAL.md` и комментарий в `digest.js`

**Files:**
- Modify: `MANUAL.md:644`, `MANUAL.md:720`
- Modify: `digest.js:30`

- [ ] **Step 1: `MANUAL.md` — убрать упоминание выбора порога**

  ```markdown
  <!-- было (MANUAL.md:643-644): -->
  Агент тупеет задолго до конца окна, а почистить себя сам не может. Включите в настройках
  «Перезапускать агента, когда контекст заполнится» и выберите, при каком заполнении спрашивать.
  Дальше сворм всё делает сам: ...

  <!-- стало: -->
  Агент тупеет задолго до конца окна, а почистить себя сам не может. Включите в настройках
  «Перезапускать агента, когда контекст заполнится» — порог, при котором спрашивать, сворм
  считает сам, отдельно для каждой вкладки, по тому, насколько её контекст вырос от старта.
  Дальше сворм всё делает сам: ...
  ```

  ```markdown
  <!-- было (MANUAL.md:718-720): -->
  **Общее.** Что не зависит от того, чем открыта вкладка: запускать агента сразу или открывать
  чистый терминал, спрашивать ли при открытии (когда подписок несколько), режим разрешений
  (manual, edits, plan, auto) и порог перезапуска по контексту.

  <!-- стало: -->
  **Общее.** Что не зависит от того, чем открыта вкладка: запускать агента сразу или открывать
  чистый терминал, спрашивать ли при открытии (когда подписок несколько), режим разрешений
  (manual, edits, plan, auto) и перезапуск агента по заполнению контекста.
  ```

- [ ] **Step 2: `digest.js` — поправить ссылку на исчезнувший `clampPct`**

  ```js
  // было (digest.js:30-32):
  // «Не задано» и «задано нулём» — разные вещи, та же ловушка, что у restart.clampPct: сюда
  // приходит localStorage.getItem, а он на несохранённой настройке отдаёт null. Через Number(null)
  // это 0 — конечное число, — и потолок молча улетел бы к MIN_LEN вместо умолчания.

  // стало:
  // «Не задано» и «задано нулём» — разные вещи: сюда приходит localStorage.getItem, а он на
  // несохранённой настройке отдаёт null. Через Number(null) это 0 — конечное число, — и потолок
  // молча улетел бы к MIN_LEN вместо умолчания.
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add MANUAL.md digest.js
  git commit -m "$(cat <<'EOF'
  docs: обновить упоминания порога перезапуска после ухода ползунка

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01XPq7ZvuYeCJaM74BwpXpeo
  EOF
  )"
  ```

---

### Task 5: Полный прогон тестов

**Files:** нет изменений — только проверка.

- [ ] **Step 1: Прогнать весь тестовый набор**

  Run: `npm test`
  Expected: все тесты в списке `package.json#scripts.test` заканчиваются `ok`/`passed`, без
  `FAIL`. Особое внимание — `restart.test.js`, `dom-ids.test.js`, `undefined-calls.test.js`,
  `preload-contract.test.js`, `toplevel.test.js` (все они трогают файлы этого плана).

- [ ] **Step 2: Ручная проверка на живых данных (без перезапуска приложения)**

  Приложение уже запущено в других вкладках сворма — трогать его (`npm start`, убивать
  процесс) нельзя. Вместо этого:

  ```bash
  grep -rn "threshold\|restartPct\|clampPct\|DEFAULT_PCT\|set-restart-pct" \
    restart.js main.js renderer/renderer.js renderer/index.html MANUAL.md
  ```

  Expected: пусто (ни одного совпадения) — подтверждает, что старый API нигде не остался.

  Живое поведение (действительно ли эффективный порог стал разным для разных вкладок)
  проверяется по `restart.log` в userData после того, как в естественном ходе работы
  какая-то вкладка дойдёт до вопроса о перезапуске — этот шаг не блокирует мёрж плана, он
  наблюдается постфактум.
