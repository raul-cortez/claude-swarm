# Агрессивный порог перезапуска — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить второй, более высокий порог заполнения контекста, при переходе которого
`restart.js` печатает просьбу о перезапуске сразу, не дожидаясь паузы хода (`turnOver`).

**Architecture:** Вся логика — внутри `restart.js`, чистые функции без сайд-эффектов. Новая
функция `pctOverAggressive(s)` — тот же порог, что и `pctOver`/`effectivePct`, умноженный на
коэффициент и заклампленный в тот же потолок. `askable()` получает вторую, независимую от
`turnOver` развилку: `(мягкий порог И пауза) ИЛИ агрессивный порог`. `main.js` не меняется — он
уже передаёт всё нужное (`baselinePct`, `pct`, `status`, `bg`) в `restart.step()`.

**Tech Stack:** Node.js (CommonJS), голый `assert` в `test/restart.test.js` (без фреймворка,
свой мини-раннер в конце файла).

Спека: `docs/superpowers/specs/2026-08-31-aggressive-restart-threshold-design.md`.

---

### Task 1: Потолок порога — 75% → 60%

**Files:**
- Modify: `restart.js:25`
- Modify: `test/restart.test.js:17-20`

- [ ] **Step 1: Написать проваливающийся тест**

Замени тест `effectivePct зажат диапазоном 15–75` (строки 17-20) на:

```javascript
test('effectivePct зажат диапазоном 15–60', () => {
  assert.strictEqual(R.effectivePct(1, 7), 15, 'совсем лёгкий проект — упирается в пол');
  assert.strictEqual(R.effectivePct(5, 7), 35);
  assert.strictEqual(R.effectivePct(20, 7), 60, 'совсем тяжёлый проект — упирается в потолок');
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node test/restart.test.js`
Expected: `FAIL effectivePct зажат диапазоном 15–60` с сообщением о несовпадении `75 !== 60`
(текущий код всё ещё возвращает 75).

- [ ] **Step 3: Понизить потолок в реализации**

В `restart.js:25` заменить:

```javascript
  const MAX_PCT = 75;
```

на:

```javascript
  const MAX_PCT = 60;
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `node test/restart.test.js`
Expected: `restart: N/N ok` (весь файл проходит целиком — раннер останавливается на первом
падении, так что это заодно проверяет, что понижение потолка не сломало ничего другого).

- [ ] **Step 5: Commit**

```bash
git add restart.js test/restart.test.js
git commit -m "fix(restart): понизить потолок порога перезапуска с 75% до 60%"
```

---

### Task 2: Агрессивный порог — печатать просьбу без паузы хода

**Files:**
- Modify: `restart.js:38-44` (после `effectivePct`), `restart.js:343-349` (`pctOver`),
  `restart.js:519-546` (`askable`), `restart.js:803-815` (экспорт)
- Modify: `test/restart.test.js` (новые тесты рядом с блоком про `turnOver`, после строки 115)

- [ ] **Step 1: Написать проваливающиеся тесты**

Добавь в `test/restart.test.js` сразу после теста `'спрашиваем вкладку, которая отдала ход, — а
работающую не трогаем'` (заканчивается на строке 115, `});`):

```javascript
// Агрессивный порог: не ждёт паузы хода, полагаясь на то, что Claude Code CLI сам ставит
// напечатанное в очередь, пока агент занят (см. 2026-08-31-aggressive-restart-threshold-design.md).
test('агрессивный порог печатает просьбу, не дожидаясь паузы хода', () => {
  // baseline 5 → мягкий порог 5×7=35, агрессивный min(35×1.5, 60)=52.5.
  const r = step(idle(), { pct: 53, status: 'running', bg: false });
  assert.strictEqual(r.action, 'ask');
});

test('мягкий порог пройден, агрессивный ещё нет — работающую вкладку по-прежнему не трогаем', () => {
  // pct=40 ≥ мягкого порога 35, но < агрессивного 52.5 — как и до этой задачи.
  const r = step(idle(), { pct: 40, status: 'running', bg: false });
  assert.strictEqual(r.action, 'nothing');
});

test('агрессивный порог тоже упирается в общий потолок 60% — там оба порога совпадают', () => {
  // baseline 20 → мягкий min(20×7, 60)=60, агрессивный min(60×1.5, 60)=60.
  assert.strictEqual(
    step(idle(), { pct: 59, baselinePct: 20, status: 'running', bg: false }).action,
    'nothing',
    'до 60% ни мягкий, ни агрессивный ещё не пройдены',
  );
  assert.strictEqual(
    step(idle(), { pct: 60, baselinePct: 20, status: 'running', bg: false }).action,
    'ask',
    'на 60% оба порога совпадают — открывается агрессивный путь',
  );
});

test('агрессивный порог не печатает в открытую рамку', () => {
  const r = step(idle(), { pct: 53, status: 'running', bg: false, dialog: true });
  assert.strictEqual(r.action, 'nothing');
});

test('агрессивный порог не спрашивает без строки запуска, живого агента или до 15 минут работы', () => {
  assert.strictEqual(
    step(idle(), { pct: 53, status: 'running', bg: false, hasBase: false }).action,
    'nothing',
  );
  assert.strictEqual(
    step(idle(), { pct: 53, status: 'running', bg: false, shellBusy: false }).action,
    'nothing',
  );
  assert.strictEqual(
    step(idle(), { pct: 53, status: 'running', bg: false, uptimeMs: 60_000 }).action,
    'nothing',
  );
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node test/restart.test.js`
Expected: `FAIL агрессивный порог печатает просьбу, не дожидаясь паузы хода` — сегодняшний
`askable()` требует `turnOver`, а `status: 'running', bg: false` его не даёт, так что `action`
будет `'nothing'`, а тест ждёт `'ask'`.

- [ ] **Step 3: Добавить `AGGRESSIVE_MULT` и `pctOverAggressive`**

В `restart.js` сразу после функции `pctOver` (строки 343-349) добавить:

```javascript
  // Порог, при переходе которого просьбу можно печатать БЕЗ паузы хода — см.
  // docs/superpowers/specs/2026-08-31-aggressive-restart-threshold-design.md. Мягкий порог
  // (pctOver) остаётся мягким и по-прежнему ждёт turnOver — это только вторая, более высокая
  // планка: контекст настолько близок к автосжатию, что вежливость подождать паузу уже не
  // оправдана.
  const AGGRESSIVE_MULT = 1.5;
  function pctOverAggressive(s) {
    const pct = Number(s.pct);
    if (!isFinite(pct) || pct <= 0) return false;
    const soft = effectivePct(s.baselinePct, s.mult);
    if (soft == null) return false;
    const threshold = Math.min(MAX_PCT, soft * AGGRESSIVE_MULT);
    return pct >= threshold;
  }
```

- [ ] **Step 4: Дать агрессивному порогу второй путь в `askable()`**

В `restart.js` заменить тело `askable()` (строки 521-546):

```javascript
  function askable(st, s, now) {
    // Есть ли чем перезапускать. Спрашивать вкладку, которую мы всё равно не поднимем, — это не
    // впустую, это во вред: просьба в двадцать строк печатается В ЖИВОЙ разговор, агент тратит на
    // ответ ход и пишет эстафету в файл посреди чужого репозитория, а перезапуск потом упирается
    // в «не знаю, чем её запускать». И так каждые двадцать минут до утра: разрешение обнуляет
    // счётчик молчания, поэтому потолок, который такие круги обрывает, здесь не срабатывает
    // никогда. Без строки бывают три вкладки: чистый терминал, агент, набранный руками с самого
    // начала, и та, где агента сменили руками (см. session:forgetLaunch).
    if (!s.hasBase) return false;
    // А агент-то там есть? «Готов» на пустой оболочке выглядит так же, как «готов» у отдохнувшего
    // агента, а снимок расхода живёт своей жизнью ещё три четверти часа после того, как Клода
    // закрыли руками. Без этой проверки просьба уезжала бы в ШЕЛЛ, и он послушно попытался бы её
    // выполнить. `undefined` — Windows, там про процессы мы не знаем ничего.
    if (!agentPresent(s)) return false;
    if (boxOpen(s)) return false;
    if (!s.uptimeMs || s.uptimeMs < MIN_UPTIME_MS) return false;
    if (st.retryAt && now < st.retryAt) return false;
    // Два пути к «пора»:
    //   • мягкий — порог пройден И ход отдан (turnOver), как было всегда: вкладку, которая
    //     прощается зовом, мы не спросили бы никогда — а это как раз те вкладки, ради которых
    //     всё и делалось (см. turnOver);
    //   • агрессивный — порог пройден настолько, что ждать паузу уже не стоит, см.
    //     docs/superpowers/specs/2026-08-31-aggressive-restart-threshold-design.md. Он всегда ≥
    //     мягкого (коэффициент > 1), так что к его переходу мягкий уже пройден — отдельной гонки
    //     между ними нет.
    if (pctOver(s) && turnOver(s)) return true;
    return pctOverAggressive(s);
  }
```

- [ ] **Step 5: Экспортировать `AGGRESSIVE_MULT`**

В `restart.js` в блоке `return { ... }` (строка 804) добавить `AGGRESSIVE_MULT` в список рядом с
`DEFAULT_MULT`:

```javascript
    MIN_PCT, MAX_PCT, DEFAULT_MULT, AGGRESSIVE_MULT, MIN_UPTIME_MS, RETRY_MS, ANSWER_WAIT_MS,
```

- [ ] **Step 6: Убедиться, что все тесты проходят**

Run: `node test/restart.test.js`
Expected: `restart: N/N ok`

- [ ] **Step 7: Прогнать полный набор тестов проекта**

Run: `npm test`
Expected: все пакеты тестов проходят (в частности `test/night.test.js`, `test/subs.test.js` —
они тоже читают статуслайн и могли бы задеть общий код, если бы правка вышла за пределы
`restart.js`; по плану она в них не заходит, но так спокойнее).

- [ ] **Step 8: Commit**

```bash
git add restart.js test/restart.test.js
git commit -m "feat(restart): агрессивный порог печатает просьбу, не дожидаясь паузы хода"
```

---

## Self-Review

**Spec coverage:**
- Потолок 75→60 — Task 1. ✅
- `AGGRESSIVE_MULT=1.5`, `pctOverAggressive`, клампится в `MAX_PCT` — Task 2, Step 3. ✅
- `askable()` — мягкий путь не изменился (порог + пауза), агрессивный не требует паузы — Task 2,
  Step 4. ✅
- Общие защёлки (`hasBase`, `agentPresent`, `boxOpen`, `uptimeMs`, `retryAt`) действуют на оба
  пути — Task 2, Step 1 (тесты «не спрашивает без строки запуска / живого агента / 15 минут» и
  «не печатает в открытую рамку»), Step 4 (защёлки стоят до развилки). ✅
- Вырожденный случай — оба порога совпадают на потолке 60% для тяжёлых проектов — Task 2, тест
  «упирается в общий потолок». ✅
- `main.js` не трогаем — план не содержит правок `main.js`. ✅
- Текст просьбы (`askText`) не меняется для агрессивного пути — план не трогает `askText`. ✅
- Жёсткий гейт на подагентов сознательно не делаем — план его не содержит. ✅

**Placeholder scan:** нет TBD/TODO, весь код в шагах полный, команды с ожидаемым выводом
указаны.

**Type consistency:** `pctOverAggressive(s)` принимает тот же объект `s`, что и `pctOver(s)` —
поля `pct`, `baselinePct`, `mult`, как в `sig()`/`main.js:5796-5813`. `AGGRESSIVE_MULT`
экспортируется тем же способом, что и `DEFAULT_MULT`.
