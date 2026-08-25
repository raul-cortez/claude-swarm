# Итог от агента вместо утреннего отчёта — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** убрать ночной отчёт целиком и вместо него заставить агента автономной вкладки писать итог после задачи.

**Architecture:** сперва добавляем новое (текст `summaryNote`, его доставка хуком и вопросом про порог фазы) — тесты зелёные на каждом шаге; потом режем отчёт снизу вверх: `night.js` → `main.js` → рендерер и preload → телеграм → доки. Спека: `docs/superpowers/specs/2026-08-25-agent-summary-design.md`.

**Tech Stack:** чистый Node (CommonJS в приложении, ESM в хуке), самописные тест-раннеры в `test/*.test.js`, `npm test`.

---

### Task 1: `summaryNote` в night.js

**Files:**
- Modify: `night.js` (рядом с `askBody`, до `withProtocol`)
- Test: `test/night.test.js` (секция «тексты», после теста про три штатных ответа)

- [ ] **Step 1: Написать падающий тест**

```js
test('итог требует сказать, что решено без человека', () => {
  const t = night.summaryNote();
  assert.match(t, /итог/i, 'итог должен называться итогом');
  assert.match(t, /сам|без человека/i, 'итог обязан рассказать про решения без человека');
  assert.match(t, /осталось|проверять/i, 'итог обязан сказать, что осталось');
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node test/night.test.js`
Expected: `FAIL  итог требует сказать, что решено без человека` — `night.summaryNote is not a function`

- [ ] **Step 3: Реализовать**

В `night.js` после `askBody()`:

```js
// Итог задачи. Приложение видит, ЧТО происходило на экране, и не видит, ЧТО сделано: рассказ о
// работе оно собирало из следов — отказов хука, простоев, времени конца хода, — и выходил
// пересказ поведения вкладки вместо результата. Знает результат один агент, значит и
// рассказывать должен он.
//
// Отдельный текст, а не строка внутри правила: правило человек переписывает под свой уклад
// (ruleText), и требование уехало бы вместе с абзацем — та же тихая поломка, что описана про
// метку в protocol().
function summaryNote() {
  return [
    'Задача кончилась — напиши итог одним сообщением:',
    'что сделано; что ты решил сам вместо человека и почему;',
    'что осталось и чем это проверять.',
    'Человек прочитает его, открыв вкладку, — другого рассказа о твоей работе у него нет.',
  ].join(' ');
}
```

И в экспорт модуля, рядом с `askBody`: `summaryNote,`.

- [ ] **Step 4: Тест зелёный**

Run: `node test/night.test.js`
Expected: `ok  итог требует сказать, что решено без человека`

- [ ] **Step 5: Коммит**

```bash
git add night.js test/night.test.js
git commit -m "feat(auto): текст итога, который агент пишет после задачи"
```

---

### Task 2: вопрос про порог фазы дописывает итог

**Files:**
- Modify: `night.js` — `askText`
- Test: `test/night.test.js` (секция «свои формулировки»)

- [ ] **Step 1: Написать падающие тесты**

```js
test('вопрос про фазу зовёт написать итог — и к заготовке, и к своему тексту', () => {
  assert.ok(night.askText('', '[swarm:вопрос]').includes(night.summaryNote()),
    'заготовка потеряла итог');
  assert.ok(night.askText('Свой вопрос про фазу.', '[swarm:вопрос]').includes(night.summaryNote()),
    'свой текст потерял итог');
});

test('итог не повторяется, если он уже назван в тексте', () => {
  const t = night.askText('Спроси себя. ' + night.summaryNote(), '[swarm:вопрос]');
  assert.strictEqual(t.split('Задача кончилась').length - 1, 1, 'итог сказан дважды');
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node test/night.test.js`
Expected: `FAIL  вопрос про фазу зовёт написать итог…` — заготовка итога не содержит.

- [ ] **Step 3: Реализовать**

В `night.js` заменить тело `askText`:

```js
// Итог дописываем ВСЕГДА и снаружи редактируемого текста — по той же причине, по какой
// снаружи живёт метка (см. protocol): вопрос про порог фазы человек правит под свой уклад, и
// требование, лежащее внутри абзаца, уехало бы вместе с ним. А спрашивают его ровно в тот миг,
// когда агент отвечает «всё сделано», — то есть тогда, когда итог и нужен.
function askText(custom, tag) {
  const t = String(custom == null ? '' : custom).trim();
  return withSummary(withProtocol(t ? fill(t, tag || '[swarm:вопрос]') : askBody(), tag));
}
```

И рядом с `withProtocol`:

```js
function withSummary(text) {
  const t = String(text == null ? '' : text).trim();
  const s = summaryNote();
  if (!t) return s;
  return t.includes(s) ? t : t + ' ' + s;
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `node test/night.test.js`
Expected: обе строки `ok`, остальные тесты по-прежнему проходят.

- [ ] **Step 5: Коммит**

```bash
git add night.js test/night.test.js
git commit -m "feat(auto): вопрос про порог фазы зовёт написать итог"
```

---

### Task 3: хук говорит про итог в начале задачи

**Files:**
- Modify: `hooks/swarm-signal.mjs` — дубликат текста, ветка `UserPromptSubmit` в `outputFor`, экспорт
- Test: `test/hook.test.js`, `test/night.test.js` (секция «дубликаты в хуке»)

- [ ] **Step 1: Написать падающие тесты**

В `test/hook.test.js`, после теста «в начало хода уезжают числа расхода»:

```js
test('автономной вкладке в начало задачи уезжает просьба про итог', () => {
  const m = H.loadMatcher(() => null);
  const out = H.outputFor({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }, m, [], 'desk',
    { autoSessions: ['s1'], nowSec: 0 });
  assert.match(out.hookSpecificOutput.additionalContext, /Задача кончилась/);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
});

test('вкладке без мандата про итог не говорят', () => {
  const m = H.loadMatcher(() => null);
  const out = H.outputFor({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }, m, [], 'desk',
    { autoSessions: [], nowSec: 0 });
  assert.ok(!out || !out.hookSpecificOutput, 'обычной вкладке добавлять нечего');
});

test('общий ночной режим тоже зовёт писать итог', () => {
  const m = H.loadMatcher(() => null);
  const out = H.outputFor({ hook_event_name: 'UserPromptSubmit', session_id: 's9' }, m, [], 'night',
    { autoSessions: [], nowSec: 0 });
  assert.match(out.hookSpecificOutput.additionalContext, /Задача кончилась/);
});

test('числа расхода и просьба про итог едут вместе', () => {
  const m = H.loadMatcher(() => null);
  const out = H.outputFor({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }, m, [], 'desk',
    { usage: { five: { spent: 93, resetsAt: 100 }, seven: { spent: 61 } }, autoSessions: ['s1'], nowSec: 0 });
  assert.match(out.hookSpecificOutput.additionalContext, /5ч 93%/);
  assert.match(out.hookSpecificOutput.additionalContext, /Задача кончилась/);
});
```

В `test/night.test.js`, в секцию «дубликаты в хуке»:

```js
test('просьба про итог в хуке слово в слово совпадает с night.js', async () => {
  const H = await import('../hooks/swarm-signal.mjs');
  assert.strictEqual(H.summaryNote(), night.summaryNote());
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node test/hook.test.js && node test/night.test.js`
Expected: `H.summaryNote is not a function`, и `additionalContext` у автономной вкладки отсутствует.

- [ ] **Step 3: Реализовать**

В `hooks/swarm-signal.mjs`, рядом с `nightRuleBody`:

```js
// Итог задачи. Дубликат night.js summaryNote — у хука нет доступа к модулям приложения (та же
// причина, что у правила и порогов), сверяется тестом.
const summaryNote = () => [
  'Задача кончилась — напиши итог одним сообщением:',
  'что сделано; что ты решил сам вместо человека и почему;',
  'что осталось и чем это проверять.',
  'Человек прочитает его, открыв вкладку, — другого рассказа о твоей работе у него нет.',
].join(' ');
```

В `outputFor`, там где считается `note`:

```js
  // Начало хода — единственный миг, когда автономной вкладке можно положить требование в
  // контекст ДО работы. Сказать его в конце нельзя: конец хода мы узнаём тогда, когда агент уже
  // замолчал.
  const wantsSummary = payload && payload.hook_event_name === 'UserPromptSubmit'
    && !isSubagent(payload) && (presence === 'night' || auto);
  const note = [(payload && payload.hook_event_name === 'UserPromptSubmit')
    ? usageNote(ex.usage, nowSec) : '', wantsSummary ? summaryNote() : ''].filter(Boolean).join('\n\n');
```

Экспорт: добавить `summaryNote` в список.

- [ ] **Step 4: Тесты зелёные**

Run: `node test/hook.test.js && node test/night.test.js`
Expected: все `ok`.

- [ ] **Step 5: Коммит**

```bash
git add hooks/swarm-signal.mjs test/hook.test.js test/night.test.js
git commit -m "feat(auto): автономная вкладка узнаёт про итог в начале задачи"
```

---

### Task 4: вырезать сводку и журнал из night.js

**Files:**
- Modify: `night.js` — удалить `digest`, `digestText`, `STATE_ORDER`, `STATE_BADGE`, `eta`, `KINDS`, `entry`, `line`, `parse`, поправить шапку файла и экспорт
- Modify: `test/night.test.js` — удалить секции «журнал» и «утренняя сводка», перенацелить тест про `fmtEta`

- [ ] **Step 1: Снести тесты сводки и журнала**

Удалить из `test/night.test.js` тесты со строк секций `// --- журнал ---`, `// --- утренняя сводка ---` и `// --- форма сводки ---` вместе с их вспомогательными данными (`entries()` и прочее, что после удаления никем не зовётся). Поправить шапку файла: журнала и сводки в нём больше нет.

Тест `отсчёт до сброса в хуке и в сводке пишется одинаково` перенацелить на живого потребителя — строку статуса:

```js
test('отсчёт до сброса в хуке и в строке статуса пишется одинаково', async () => {
  const H = await import('../hooks/swarm-signal.mjs');
  const SL = require('../swarm-statusline');
  for (const sec of [0, 59, 60, 3600, 3660, 86_400, 90_000]) {
    assert.strictEqual(H.fmtEta(sec), SL.fmtEta(sec), 'sec=' + sec);
  }
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node test/night.test.js`
Expected: FAIL — `night.digest is not a function` там, где тесты ещё остались, либо чистый прогон, если удалено всё; главное, чтобы `fmtEta`-тест уже сравнивал хук со строкой статуса и был зелёным.

- [ ] **Step 3: Вырезать из night.js**

Удалить `eta`, `digest`, `digestText`, `STATE_ORDER`, `STATE_BADGE`, `KINDS`, `entry`, `line`, `parse` и секции комментариев `--- сводка ---` / `--- журнал ---`. Оставить `clock` (её зовёт `main.js` для своего лога) и `short` (`nightKey`). Экспорт привести к:

```js
return {
  NIGHT, IDLE_MS, NUDGE_DELAY_MS, WARMUP_MS, BOOT_MS, WAKE_LAG_MS, MAX_CONTINUES, MAX_NUDGES,
  MAX_ASKS, GATE_FIVE, GATE_SEVEN,
  rule, phaseAsk, wakeWord, ruleText, askText, ruleBody, askBody, summaryNote, protocol,
  nudgeDecision, phaseDecision, clock, short,
};
```

В шапке файла заменить абзац про отчёт: приложение видит поведение, а не результат, поэтому рассказывает о работе сам агент (`summaryNote`), а сводки здесь больше нет.

- [ ] **Step 4: Тесты зелёные**

Run: `node test/night.test.js`
Expected: все `ok`, счётчик в конце меньше прежнего.

- [ ] **Step 5: Коммит**

```bash
git add night.js test/night.test.js
git commit -m "refactor(auto): night.js без сводки и журнала"
```

---

### Task 5: вырезать журнал и отчёт из main.js

**Files:**
- Modify: `main.js`

- [ ] **Step 1: Удалить проводку**

Убрать `nightLog`, `nightPath`, `nightDigestPath`, `nightEntries`, `nightTabsNow`, `nightBuildDigest`, `nightDigestNow`, `nightLoadDigest`, `nightMarkRead`, `pruneNight`, `autoAfterChange`, `nightFrom`, `TG.nightFrom` (и его чтение/запись в `tgLoad`/`persist`), `d.autoSeen`, IPC `night:dismiss`, поле `digest` и `from` в `nightState()`. Все вызовы `nightLog(...)` удалить, оставив сами ветви и счётчики нетронутыми. Вызовы `autoAfterChange(wasAny)` в `setTabAuto` и `nightSwitch` удалить вместе с переменной `wasAny`.

- [ ] **Step 2: Добавить разовую уборку старых файлов**

Там, где сейчас зовётся `pruneNight()` при старте:

```js
// Отчёта больше нет, а его файлы остались лежать в userData. Удаляем разово и молча: читать
// их некому, а держать в чужой папке мусор своей прошлой версии — невежливо.
function dropNightFiles() {
  for (const name of ['night.jsonl', 'night-digest.json']) {
    try { fs.unlinkSync(path.join(app.getPath('userData'), name)); } catch (_) { /* уже нет */ }
  }
}
```

и заменить вызов `pruneNight()` на `dropNightFiles()`.

- [ ] **Step 3: Проверить, что ничего не осталось**

Run: `grep -n "digest\|nightLog\|nightFrom\|autoSeen\|pruneNight\|nightEntries" main.js`
Expected: только `hash.digest('hex')` в проверке обновлений.

- [ ] **Step 4: Прогнать тесты**

Run: `npm test`
Expected: все наборы зелёные (`test/toplevel.test.js` проверяет, что main.js разбирается).

- [ ] **Step 5: Коммит**

```bash
git add main.js
git commit -m "refactor(auto): main.js без журнала и сборки отчёта"
```

---

### Task 6: убрать окно сводки из рендерера

**Files:**
- Modify: `renderer/renderer.js`, `renderer/styles.css`, `preload.js`

- [ ] **Step 1: Вырезать окно и метки**

Удалить `openNightModal`, `paintNightMarks`, вызов `paintNightMarks` в `renderNightPill`, ветку `else if (!nightNow.on && rows)` вместе с `rows`, поле `digest` из `nightNow`. Обработчик клика по значку оставить в двух ветвях: «забрать все вкладки себе» и «снять ночной режим» — без `openNightModal()`. В шапке секции заменить рассказ про сводку: значок теперь только про то, что мандат ещё в силе.

- [ ] **Step 2: Вырезать стили**

Удалить из `renderer/styles.css` правила `.modal.night`, `.night-sum`, `.night-body`, `.night-card`, `.nc-head`, `.nc-name`, `.nc-badge`, `.nc-sec`, `.nc-sec-title`, `.nc-row`, `.nc-text`, `.nc-meta`, `.nc-note`, `.night-quiet`, `.night-empty`, `.night-mark` и комментарии, которые остались без правил.

- [ ] **Step 3: Вырезать мост**

Удалить `dismiss` из `night` в `preload.js`.

- [ ] **Step 4: Проверить, что ничего не осталось**

Run: `grep -rn "night-mark\|nc-\|openNightModal\|night.dismiss\|nightNow.digest" renderer preload.js`
Expected: пусто.

- [ ] **Step 5: Прогнать тесты и закоммитить**

Run: `npm test`

```bash
git add renderer/renderer.js renderer/styles.css preload.js
git commit -m "refactor(auto): окно утренней сводки убрано"
```

---

### Task 7: убрать /morning из телеграма

**Files:**
- Modify: `telegram.js` (меню команд), `main.js` (`tgMorning`, `tgNightCmd`, `TG_PRESENCE_SAID`)
- Test: `test/telegram.test.js` — если в нём пиннится список команд, поправить

- [ ] **Step 1: Вырезать команду**

Удалить строку `{ command: 'morning', … }` из меню бота в `telegram.js`, функцию `tgMorning` и её вызовы, ветку `if (u.command === 'morning')` в разборе команд. В `tgNightCmd` вместо `await tgMorning(u)` оставить одно сообщение о возвращении; из текста включения ночного режима убрать «Отчёт — /morning.»; в `TG_PRESENCE_SAID.night` заменить «потом отчёт» на то, что вкладки пишут итог сами.

- [ ] **Step 2: Проверить**

Run: `grep -rn "morning" main.js telegram.js test/`
Expected: пусто.

- [ ] **Step 3: Прогнать тесты и закоммитить**

Run: `npm test`

```bash
git add main.js telegram.js test/telegram.test.js
git commit -m "refactor(auto): /morning убран, отчёта больше нет"
```

---

### Task 8: доки

**Files:**
- Modify: `README.md`, `MANUAL.md`, `DEVELOPMENT.md`, `CHANGELOG.md`
- Delete: `docs/img/21-night-morning.png`, `docs/img/25-report-pill.png`

- [ ] **Step 1: README**

Убрать раздел про отчёт (значок, карточки, метки, `/morning`) и строку `/morning` из таблицы команд. Вместо него — абзац: агент автономной вкладки пишет итог, закончив задачу; человек читает его, открыв вкладку, а из телеграма он приходит обычным итогом хода. Поправить строку про «работу без вас» в таблице возможностей и ответ в разделе про забытый ночной режим (клик возвращает, окна больше нет).

- [ ] **Step 2: MANUAL**

Тем же образом: раздел про отчёт заменить абзацем про итог, убрать картинки, строку `/morning` из таблицы команд, упоминания отчёта в местах про лимиты и про метку.

- [ ] **Step 3: DEVELOPMENT**

Строку `night.js` привести к: «Ночной режим: правило агенту, толчки, вопрос про порог фазы, итог после задачи».

- [ ] **Step 4: CHANGELOG**

Запись в раздел «не выпущено»:

```
- feat(auto): итог от агента вместо утреннего отчёта — вкладка сама рассказывает, что решила без человека
```

- [ ] **Step 5: Проверить и закоммитить**

Run: `grep -rn "morning\|отчёт" README.md MANUAL.md DEVELOPMENT.md`
Expected: только то, что про отчёт не говорит (например, «отчёты мыши» в других файлах).

```bash
git add README.md MANUAL.md DEVELOPMENT.md CHANGELOG.md docs/img
git commit -m "docs(auto): итог от агента вместо утреннего отчёта"
```

---

### Task 9: последняя проверка

- [ ] **Step 1: Весь набор**

Run: `npm test`
Expected: каждый набор зелёный, ни одного FAIL.

- [ ] **Step 2: Убедиться, что отчёта нигде не осталось**

Run: `grep -rn "digest\|morning\|night.jsonl" --include="*.js" --include="*.mjs" . | grep -v node_modules`
Expected: только `hash.digest` в `updater.js`, `updater-core.js`, `main.js` и `screen.js`, и `dropNightFiles` в `main.js`.
