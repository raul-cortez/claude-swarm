// Plain-node tests for the Telegram protocol layer (telegram.js). No network: the
// poller takes its fetch and its sleep as dependencies, so the loop — offsets, backoff,
// fatal errors — is pinned here rather than discovered in production.
const assert = require('assert');
const T = require('../telegram');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const TOKEN = '123456789:AAHfake_token_value_that_is_long_enough_x';

// --- token -------------------------------------------------------------------

test('looksLikeToken accepts what BotFather gives out', () => {
  assert.strictEqual(T.looksLikeToken(TOKEN), true);
  assert.strictEqual(T.looksLikeToken('  ' + TOKEN + '  '), true, 'trims');
});

test('looksLikeToken rejects the usual paste accidents', () => {
  assert.strictEqual(T.looksLikeToken(''), false);
  assert.strictEqual(T.looksLikeToken('123456789'), false, 'no secret half');
  assert.strictEqual(T.looksLikeToken('123456789:short'), false, 'truncated copy');
  assert.strictEqual(T.looksLikeToken('Use this token to access the HTTP API:'), false);
  assert.strictEqual(T.looksLikeToken(null), false);
});

test('maskToken keeps the bot id and hides the secret', () => {
  const m = T.maskToken(TOKEN);
  assert.ok(m.startsWith('123456789:'), m);
  assert.ok(!m.includes('fake_token_value'), 'the secret must not survive masking');
  assert.strictEqual(T.maskToken('nonsense'), '');
});

// --- pairing -----------------------------------------------------------------

test('pairCode has no lookalike characters', () => {
  const code = T.pairCode();
  assert.strictEqual(code.length, T.CODE_LEN);
  assert.ok(!/[01OIL]/.test(code), 'ambiguous glyph in ' + code);
});

test('deepLink builds a start link, and a startgroup one for a supergroup', () => {
  assert.strictEqual(T.deepLink('@myswarmbot', 'AB23CD'), 'https://t.me/myswarmbot?start=AB23CD');
  assert.strictEqual(T.deepLink('myswarmbot', 'AB23CD', { group: true }),
    'https://t.me/myswarmbot?startgroup=AB23CD');
});

test('pairingMatch accepts /start with the code, in private and in a group', () => {
  assert.strictEqual(T.pairingMatch({ text: '/start AB23CD' }, 'AB23CD'), true);
  assert.strictEqual(T.pairingMatch({ text: '/start@myswarmbot AB23CD' }, 'AB23CD'), true);
  assert.strictEqual(T.pairingMatch({ text: 'ab23cd' }, 'AB23CD'), true, 'typed by hand, any case');
});

test('pairingMatch rejects a wrong or missing code', () => {
  assert.strictEqual(T.pairingMatch({ text: '/start' }, 'AB23CD'), false);
  assert.strictEqual(T.pairingMatch({ text: '/start WRONG1' }, 'AB23CD'), false);
  assert.strictEqual(T.pairingMatch({ text: 'AB23CD extra words' }, 'AB23CD'), false);
  assert.strictEqual(T.pairingMatch(null, 'AB23CD'), false);
  assert.strictEqual(T.pairingMatch({ text: 'AB23CD' }, ''), false);
});

// --- updates -----------------------------------------------------------------

const msgUpdate = (over) => ({
  update_id: 10,
  message: Object.assign({
    message_id: 5,
    from: { id: 42, first_name: 'Женя' },
    chat: { id: -100123, type: 'supergroup', is_forum: true },
    text: 'да, вариант 2',
  }, over),
});

test('readUpdate pulls out chat, author, text and the reply key', () => {
  const u = T.readUpdate(msgUpdate({ reply_to_message: { message_id: 77 } }));
  assert.strictEqual(u.kind, 'message');
  assert.strictEqual(u.chatId, -100123);
  assert.strictEqual(u.fromId, 42);
  assert.strictEqual(u.text, 'да, вариант 2');
  assert.strictEqual(u.replyToId, 77, 'the reply is the routing key');
  assert.strictEqual(u.isForum, true);
});

test('readUpdate reports a forum topic only for a topic message', () => {
  assert.strictEqual(T.readUpdate(msgUpdate({ is_topic_message: true, message_thread_id: 9 })).threadId, 9);
  assert.strictEqual(T.readUpdate(msgUpdate({ message_thread_id: 9 })).threadId, null);
});

test('readUpdate parses a command with and without arguments', () => {
  assert.deepStrictEqual(
    (({ command, args }) => ({ command, args }))(T.readUpdate(msgUpdate({ text: '/start AB23CD' }))),
    { command: 'start', args: 'AB23CD' });
  assert.strictEqual(T.readUpdate(msgUpdate({ text: '/tabs' })).command, 'tabs');
  assert.strictEqual(T.readUpdate(msgUpdate({ text: 'не команда' })).command, null);
});

test('readUpdate carries a voice note through (phase two transcribes it)', () => {
  const u = T.readUpdate(msgUpdate({ text: undefined, voice: { file_id: 'f1', duration: 3 } }));
  assert.deepStrictEqual(u.voice, { fileId: 'f1', seconds: 3 });
});

test('readUpdate survives junk and non-message updates', () => {
  assert.strictEqual(T.readUpdate(null), null);
  assert.strictEqual(T.readUpdate({ update_id: 1, poll: {} }).kind, 'other');
});

// --- картинки ------------------------------------------------------------------
// Скриншот — то, чем с телефона показывают беду. До этого он молча пропадал: ни ответа, ни
// следа, и это неотличимо от сломанного моста.

test('readUpdate берёт самый крупный размер картинки', () => {
  const u = T.readUpdate(msgUpdate({
    text: undefined,
    photo: [
      { file_id: 'small', file_size: 900 },
      { file_id: 'big', file_size: 90000 },
    ],
  }));
  assert.deepStrictEqual(u.photo, { fileId: 'big', name: '', bytes: 90000 });
  assert.strictEqual(u.media, null, 'картинка разобрана — отказывать не в чем');
});

test('картинка «как файл» — тоже картинка, и имя сохраняется', () => {
  const u = T.readUpdate(msgUpdate({
    text: undefined,
    document: { file_id: 'd1', file_name: 'ошибка.png', mime_type: 'image/png', file_size: 12 },
  }));
  assert.deepStrictEqual(u.photo, { fileId: 'd1', name: 'ошибка.png', bytes: 12 });
});

test('подпись к картинке становится текстом задачи', () => {
  const u = T.readUpdate(msgUpdate({
    text: undefined, caption: 'почему тут пусто?', photo: [{ file_id: 'p' }],
  }));
  assert.strictEqual(u.text, 'почему тут пусто?');
  assert.strictEqual(u.photo.fileId, 'p');
});

test('прочие вложения названы, чтобы отказ был человеческим', () => {
  const kinds = {
    document: { file_id: 'x', mime_type: 'application/pdf' },
    video: { file_id: 'x' },
    sticker: { file_id: 'x' },
  };
  for (const [k, v] of Object.entries(kinds)) {
    assert.strictEqual(T.readUpdate(msgUpdate({ text: undefined, [k]: v })).media, k);
  }
  assert.strictEqual(T.mediaLabel('video_note'), 'видеокружок');
  assert.strictEqual(T.mediaLabel('нечто'), 'это', 'незнакомое не должно ломать фразу');
  assert.strictEqual(T.readUpdate(msgUpdate({})).media, null, 'у обычного текста вложений нет');
});

// --- бота выгнали или разжаловали ------------------------------------------------

test('readUpdate разбирает смену членства бота', () => {
  const u = T.readUpdate({
    update_id: 3,
    my_chat_member: {
      chat: { id: -100123 },
      from: { id: 42, first_name: 'Женя' },
      new_chat_member: { status: 'kicked' },
    },
  });
  assert.strictEqual(u.kind, 'membership');
  assert.strictEqual(u.chatId, -100123);
  assert.strictEqual(u.status, 'kicked');
  assert.strictEqual(T.senderLabel(u), 'Женя (42)');
});

// --- ссылка на тему ---------------------------------------------------------------

test('topicLink адресует тему супергруппы', () => {
  assert.strictEqual(T.topicLink(-1001234567890, 9), 'https://t.me/c/1234567890/9');
  assert.strictEqual(T.topicLink(-1001234567890, null), null, 'нет темы — нет ссылки');
  assert.strictEqual(T.topicLink(12345, 9), null, 'личный чат так не адресуется');
});

test('escapeHtml бережёт имя вкладки от разметки', () => {
  assert.strictEqual(T.escapeHtml('<b> & api'), '&lt;b&gt; &amp; api');
});

// --- служебные записи форума ---------------------------------------------------
// Единственный канал, по которому телега сообщает «тему переименовали/закрыли». Без их
// разбора синхронизация возможна только в одну сторону — из сворма в телегу; ровно так и
// было, и это первое, на что пожаловались.

test('readUpdate разбирает переименование темы', () => {
  const u = T.readUpdate(msgUpdate({
    text: undefined, message_thread_id: 9, forum_topic_edited: { name: 'оплата' },
  }));
  assert.deepStrictEqual(u.service, { kind: 'topic-edited', name: 'оплата' });
  assert.strictEqual(u.threadId, 9, 'у служебной записи тема есть даже без is_topic_message');
});

test('сменили одну иконку — имени нет, переносить нечего', () => {
  const u = T.readUpdate(msgUpdate({
    text: undefined, message_thread_id: 9, forum_topic_edited: { icon_custom_emoji_id: '5' },
  }));
  assert.strictEqual(u.service.kind, 'topic-edited');
  assert.strictEqual(u.service.name, null);
  // Пустая строка именем тоже не считается: вкладка без имени — вкладка, которую не позвать.
  assert.strictEqual(T.readService({ forum_topic_edited: { name: '  ' } }).name, null);
});

test('закрытие и открытие темы различаются', () => {
  assert.strictEqual(T.readService({ forum_topic_closed: {} }).kind, 'topic-closed');
  assert.strictEqual(T.readService({ forum_topic_reopened: {} }).kind, 'topic-reopened');
  assert.strictEqual(T.readService({ forum_topic_created: { name: 'a' } }).kind, 'topic-created');
});

test('обычное сообщение служебным не считается', () => {
  assert.strictEqual(T.readUpdate(msgUpdate({})).service, null);
  assert.strictEqual(T.readService(null), null);
  assert.strictEqual(T.readService({ text: 'привет' }), null);
});

// --- routing -----------------------------------------------------------------
// The rule that matters most: an answer must reach the tab it was written for, or no tab
// at all. These tests exist to make «last active tab» impossible to reintroduce.

const ctx = (over) => Object.assign({
  topicSession: new Map(),
  sent: new Map(),
  topics: {},
  tabs: [],
  alive: () => true,
}, over);

test('route: a message in a tab’s topic goes to that tab', () => {
  const c = ctx({ topicSession: new Map([[9, 'tab-a']]) });
  assert.strictEqual(T.routeMessage({ threadId: 9 }, c), 'tab-a');
});

test('route: a reply to our message goes to the session it was about', () => {
  const c = ctx({ sent: new Map([[77, 'tab-b']]) });
  assert.strictEqual(T.routeMessage({ replyToId: 77 }, c), 'tab-b');
});

test('route: a topic from an earlier run re-attaches through the tab key', () => {
  const c = ctx({ topics: { 'key-1': 9 }, tabs: [{ id: 'tab-c', tabKey: 'key-1' }] });
  assert.strictEqual(T.routeMessage({ threadId: 9 }, c), 'tab-c');
});

test('route: a topic whose tab is gone does not fall through to a neighbour', () => {
  const c = ctx({
    topics: { 'key-1': 9 },
    tabs: [{ id: 'tab-c', tabKey: 'key-1' }, { id: 'tab-d', tabKey: 'key-2' }],
    alive: (id) => id !== 'tab-c',
  });
  assert.strictEqual(T.routeMessage({ threadId: 9 }, c), null);
});

test('route: a dead session is never a target, even with a valid reply', () => {
  const c = ctx({ sent: new Map([[77, 'tab-b']]), alive: () => false });
  assert.strictEqual(T.routeMessage({ replyToId: 77 }, c), null);
});

test('route: a bare message with no topic and no reply routes NOWHERE', () => {
  assert.strictEqual(T.routeMessage({ text: 'да, вариант 2' }, ctx()), null);
  assert.strictEqual(T.routeMessage({ threadId: 999 }, ctx()), null, 'unknown topic is not a guess');
  assert.strictEqual(T.routeMessage(null, ctx()), null);
});

test('route: inside a known topic, the topic wins over a reply to another tab', () => {
  const c = ctx({ topicSession: new Map([[9, 'tab-a']]), sent: new Map([[77, 'tab-b']]) });
  assert.strictEqual(T.routeMessage({ threadId: 9, replyToId: 77 }, c), 'tab-a');
});

test('route: a message in General names no tab — it is the control channel', () => {
  assert.strictEqual(T.routeMessage({ text: 'сделай X' }, ctx()), null);
});

// --- почему отказали: сообщение об ошибке не должно врать ----------------------
// Раньше на любое «не знаю адресата» уходило «это общая тема» — включая случай, когда
// человек писал в НАСТОЯЩУЮ тему вкладки. Он шёл искать несуществующую проблему.

test('routeFailure: вне тем — это правда общая тема', () => {
  assert.strictEqual(T.routeFailure({ text: 'привет' }, { topics: { a: 9 } }), 'general');
  assert.strictEqual(T.routeFailure({ threadId: null }, { topics: {} }), 'general');
  assert.strictEqual(T.routeFailure(null, {}), 'general');
});

test('routeFailure: тема известна, но вкладки нет — «вкладка закрыта», а не «общая тема»', () => {
  assert.strictEqual(T.routeFailure({ threadId: 9 }, { topics: { 'tab-a': 9 } }), 'topic-closed');
});

test('routeFailure: тема нам неизвестна — предлагаем /sync', () => {
  assert.strictEqual(T.routeFailure({ threadId: 42 }, { topics: { 'tab-a': 9 } }), 'topic-alien');
  assert.strictEqual(T.routeFailure({ threadId: 42 }, {}), 'topic-alien');
});

// --- как текст попадает в pty -------------------------------------------------
// Один кусок `текст\r` не отправляется: Claude Code принимает крупный быстрый ввод за
// вставку и хвостовой возврат каретки кладёт в буфер переводом строки. Снаружи это
// «сообщение из телеги легло в поле ввода и осталось там».

test('inputWrites отдаёт текст и Enter ОТДЕЛЬНЫМИ записями', () => {
  assert.deepStrictEqual(T.inputWrites('посмотри тест'), ['посмотри тест', '\r']);
});

test('inputWrites оборачивает многострочное в bracketed paste, Enter — снаружи', () => {
  const w = T.inputWrites('первая\nвторая');
  assert.deepStrictEqual(w, [T.PASTE_ON + 'первая\nвторая' + T.PASTE_OFF, '\r']);
  // Enter обязан быть ВНЕ маркеров вставки, иначе он часть вставленного текста.
  assert.ok(!w[0].endsWith('\r'));
});

test('inputWrites нормализует переводы строк и не пишет пустое', () => {
  assert.deepStrictEqual(T.inputWrites('а\r\nб'), [T.PASTE_ON + 'а\nб' + T.PASTE_OFF, '\r']);
  assert.deepStrictEqual(T.inputWrites(''), []);
  assert.deepStrictEqual(T.inputWrites(null), []);
});

// --- быстрые кнопки: одно касание вместо набора команды -----------------------
// Главное требование к ним — НЕ пересекаться с кнопками разрешения. Там нажатие печатает
// номер в живой диалог, и принять «⚡ правки без спроса» за выбор варианта было бы худшим,
// что этот мост умеет. Поэтому у них свой префикс и раздельный разбор.

test('быстрое действие и разрешение не разбираются друг за друга', () => {
  const qa = T.actionData('7', 'auto');
  const perm = T.callbackData('7', 'abc123', 2);
  assert.strictEqual(T.parseCallbackData(qa), null, 'быстрая кнопка не сойдёт за разрешение');
  assert.strictEqual(T.parseAction(perm), null, 'разрешение не сойдёт за быструю кнопку');
  assert.deepStrictEqual(T.parseAction(qa), { tab: '7', action: 'auto' });
});

// Закрытие вкладки необратимо: агент завершается вместе с незаконченным ходом. Такой кнопке
// нечего делать в панели, которая висит в шапке темы всегда и по которой промахиваются пальцем.
test('в шапке темы нет кнопки, закрывающей вкладку', () => {
  const kb = T.actionKeyboard('7');
  const labels = kb.inline_keyboard.flat().map((b) => b.text);
  assert.ok(!labels.includes(T.QA_ACTIONS.kill), 'закрытие вкладки в шапке: ' + labels.join(', '));
  assert.ok(labels.includes(T.QA_ACTIONS.status), 'а обычные быстрые действия на месте');
  // Зато по явному списку она собирается — это ответ на «тему закрыли, а вкладка жива».
  const ask = T.actionKeyboard('7', ['reopen', 'kill']).inline_keyboard.flat();
  assert.deepStrictEqual(ask.map((b) => b.callback_data), ['q|7|reopen', 'q|7|kill']);
});

// «Кратко или полностью» — это просьба к агенту, а не обрезка готового ответа: краткость в
// телеге всегда делалась этой строкой.
test('подробность выбирает формулировку, а неизвестная — краткую', () => {
  assert.strictEqual(T.detailPrompt('full'), T.PROMPTS.full);
  assert.strictEqual(T.detailPrompt('short'), T.PROMPTS.short);
  assert.strictEqual(T.detailPrompt('нет такой'), T.PROMPTS.short);
  assert.strictEqual(T.detailPrompt(undefined), T.PROMPTS.short);
  assert.deepStrictEqual(T.DETAILS, ['short', 'full', 'custom']);
  // У «своей формулировки» текста в модуле нет: он живёт в настройках. Пустое положение
  // отвечает краткой заготовкой, а не пустой строкой — иначе мост просил бы агента ни о чём.
  assert.strictEqual(T.detailPrompt('custom'), T.PROMPTS.short);
  // Обе заготовки запрещают интерактивный выбор: в чате его нечем нажать.
  for (const p of Object.values(T.PROMPTS)) {
    assert.ok(/выбором клавиатурой/.test(p), p);
    assert.ok(!/\n/.test(p), 'подставляется одной строкой ввода');
  }
});

test('actionData отказывается от неизвестного действия', () => {
  assert.strictEqual(T.actionData('7', 'rm-rf'), null);
  assert.strictEqual(T.parseAction('q|7|rm-rf'), null);
  assert.strictEqual(T.parseAction('q|7'), null);
  assert.strictEqual(T.parseAction(''), null);
  assert.strictEqual(T.parseAction(null), null);
});

// Автор в журнале. Разбор «коллега жалуется, что бот не ответил» упирался в то, что автора в
// журнале не было вовсе, и искать приходилось по косвенным признакам.

test('senderLabel даёт имя с id, а без имени — один id', () => {
  assert.strictEqual(T.senderLabel({ fromName: 'Саша', fromId: 42 }), 'Саша (42)');
  assert.strictEqual(T.senderLabel({ fromName: '', fromId: 42 }), '42');
  assert.strictEqual(T.senderLabel({ fromName: 'Саша' }), 'Саша', 'пустых скобок не оставляем');
  assert.strictEqual(T.senderLabel({}), '?');
  assert.strictEqual(T.senderLabel(null), '?');
  // Перевод строки в имени разорвал бы строку журнала на две — а её читают построчно.
  assert.strictEqual(T.senderLabel({ fromName: 'Са\nша', fromId: 7 }), 'Са ша (7)');
});

test('нажатие кнопки тоже несёт автора, а не только сообщение', () => {
  const u = T.readUpdate({
    update_id: 1,
    callback_query: {
      id: 'cb1', data: 'q|3|auto',
      from: { id: 77, first_name: 'Саша', last_name: 'Петров' },
      message: { message_id: 9, chat: { id: -100 }, is_topic_message: true, message_thread_id: 5 },
    },
  });
  assert.strictEqual(u.kind, 'callback');
  assert.strictEqual(T.senderLabel(u), 'Саша Петров (77)');
});

// Кого адресует нажатие. Живая беда, которую это закрывает: номер вкладки в callback_data
// живёт только до перезапуска (id раздаются заново с единицы), а кнопки в шапке темы остаются
// навсегда. После перезапуска «q|1|auto» из темы одного репозитория указывал на вкладку с
// другим — и «вообще без вопросов» снималось у чужого агента.

test('в теме адресата называет тема, а не payload кнопки', () => {
  const at = T.callbackTab({ threadId: 12, routed: '4', payloadTab: '1' });
  assert.strictEqual(at.tab, '4', 'решает тема');
  assert.strictEqual(at.source, 'topic');
  assert.strictEqual(at.mismatch, true, 'расхождение видно вызывающему');
});

test('совпало — расхождения нет, адресат тот же', () => {
  const at = T.callbackTab({ threadId: 12, routed: '4', payloadTab: '4' });
  assert.deepStrictEqual(at, { tab: '4', source: 'topic', mismatch: false });
});

test('номера сравниваются как строки, а не по типу', () => {
  const at = T.callbackTab({ threadId: 12, routed: 4, payloadTab: '4' });
  assert.strictEqual(at.mismatch, false, 'число 4 и строка «4» — одна и та же вкладка');
});

test('тема нам неизвестна — адресата нет, и это не повод верить payload', () => {
  const at = T.callbackTab({ threadId: 99, routed: null, payloadTab: '1' });
  assert.strictEqual(at.tab, null);
  assert.strictEqual(at.source, null);
});

test('вне тем сверять не с чем — остаётся payload', () => {
  const at = T.callbackTab({ threadId: null, routed: null, payloadTab: '1' });
  assert.deepStrictEqual(at, { tab: '1', source: 'payload', mismatch: false });
});

test('actionKeyboard даёт кнопки с подписями и рабочими данными', () => {
  const kb = T.actionKeyboard('3');
  const flat = kb.inline_keyboard.flat();
  assert.ok(flat.length >= 3, 'кнопок должно быть несколько');
  for (const b of flat) {
    assert.ok(b.text && b.text.length > 1, 'подпись пустой быть не может');
    assert.deepStrictEqual(T.parseAction(b.callback_data).tab, '3');
    assert.ok(b.callback_data.length <= T.CB_MAX, 'Telegram режет callback_data по 64 байтам');
  }
  assert.ok(kb.inline_keyboard.every((row) => row.length <= 2), 'по две в ряд: подписи длинные');
});

// Подпись кнопки обязана называть цену: это не безобидные нажатия, и человек должен видеть
// разницу ДО касания. «Правки без спроса» и «авто» — разные режимы живого Claude Code, и
// раньше одна кнопка обещала первое, а делала… тоже первое, хотя называлась автомодом.
// Теперь их две, и подписи не путаются.
test('кнопки режимов называют цену и не путаются между собой', () => {
  assert.match(T.QA_ACTIONS.edits, /правки без спроса/);
  assert.match(T.QA_ACTIONS.auto, /авто/);
  assert.notStrictEqual(T.QA_ACTIONS.edits, T.QA_ACTIONS.auto);
  assert.match(T.QA_ACTIONS.manual, /спрашивать разрешение/);
});

// Выход из тупика. Живой случай: вопрос с описаниями под вариантами парсер не разобрал,
// уведомление ушло без кнопок, и на любой текст с телефона приходило «выбери вариант кнопкой»
// — кнопкой, которой в сообщении нет. С телефона нельзя было ни выбрать, ни написать словами.
// Escape — единственное нажатие, которое закрывает диалог, ничего не одобряя, поэтому кнопка с
// ним обязана существовать и собираться в клавиатуру отдельно от шапки темы: в шапке она
// прерывала бы работающего агента по промаху пальцем.
test('кнопка «закрыть диалог» есть и не висит в шапке темы', () => {
  assert.match(T.QA_ACTIONS.esc, /закрыть диалог/);
  assert.ok(!T.HEADER_ACTIONS.includes('esc'), 'в шапке темы Escape опасен: прервёт ход');
  const kb = T.actionKeyboard('5', ['esc']);
  const flat = kb.inline_keyboard.flat();
  assert.strictEqual(flat.length, 1, 'в тупике одна кнопка — она же и выход');
  assert.deepStrictEqual(T.parseAction(flat[0].callback_data), { tab: '5', action: 'esc' });
  assert.strictEqual(T.ESC, '\x1b', 'ровно то, что посылает клавиша Escape');
});

// Единственный выход из отказа «сворм в режиме компа»: писать в вкладки мост даёт только с
// телефона, значит у отказа обязана быть кнопка, которая этот режим и включает. Набирать
// /phone руками, чтобы отправить уже написанное, — работа, придуманная приложением.
test('кнопка «включить режим телефона» есть и не висит в шапке темы', () => {
  assert.match(T.QA_ACTIONS.phone, /режим телефона/);
  assert.ok(!T.HEADER_ACTIONS.includes('phone'), 'в шапке темы ей нечего делать: это не про вкладку');
  const flat = T.actionKeyboard('9', ['phone']).inline_keyboard.flat();
  assert.strictEqual(flat.length, 1);
  assert.deepStrictEqual(T.parseAction(flat[0].callback_data), { tab: '9', action: 'phone' });
});

// Отказ и включение режима — разные вещи, и подписи команд обязаны это называть: человек читает
// в меню телеги ровно их, а не наши комментарии.
test('/comp честно говорит, что в вкладки писать не будет', () => {
  const comp = T.COMMANDS.find((c) => c.command === 'comp');
  assert.ok(comp, 'команда /comp на месте');
  assert.match(comp.description, /не пис/i);
});

// И не обещает БОЛЬШЕ, чем делает. Здесь стояло «⚡ вообще без вопросов», а auto в 2.1.220
// всё равно спрашивает на опасном: человек нажимал кнопку, через минуту получал в этой же
// теме запрос разрешения и решал, что нажатие не сработало. Ложь про цену в сторону «дешевле,
// чем есть» ничем не лучше обратной.
test('кнопка auto не обещает тишины, которой не будет', () => {
  assert.doesNotMatch(T.QA_ACTIONS.auto, /без вопросов|ни о чём|не спрашивает/);
});

// «Ушёл и забыл переключить» лечится только с телефона: приложение осталось на столе.
// Поэтому эти три обязаны быть именно в МЕНЮ бота — набирать их руками в дороге никто не
// станет, а раз их не видно, значит их для человека и нет.
test('в меню бота есть «где я» и «последний ответ»', () => {
  const names = T.COMMANDS.map((c) => c.command);
  for (const c of ['phone', 'comp', 'last']) assert.ok(names.includes(c), 'нет /' + c);
});

test('список команд для меню бота непустой и с описаниями', () => {
  assert.ok(T.MENU_COMMANDS.length >= 4);
  for (const c of T.MENU_COMMANDS) {
    assert.match(c.command, /^[a-z]+$/, 'Telegram принимает только латиницу в имени команды');
    assert.ok(c.description && c.description.length > 5, c.command + ': нужно описание');
    assert.ok(c.description.length <= 256);
  }
});

// --- команды самого Клода ------------------------------------------------------
// Развилка одна и она здесь: своя команда исполняется мостом, чужая печатается в вкладку.
// Ошибка в любую сторону громкая — «/clear» уедет агенту прозой либо «/tabs» откроет в
// вкладке меню Клода вместо списка вкладок.

test('свои команды мост забирает себе, остальные — Клоду', () => {
  for (const c of T.COMMANDS) assert.strictEqual(T.isOwnCommand(c.command), true, '/' + c.command);
  assert.strictEqual(T.isOwnCommand('start'), true, 'привязка чата тоже наша');
  for (const c of ['clear', 'compact', 'model', 'agents', 'resume', 'review']) {
    assert.strictEqual(T.isOwnCommand(c), false, '/' + c + ' — команда Клода');
  }
});

// Telegram дописывает «@имя_бота» к команде, выбранной в меню группы. Строка с хвостом
// командой уже не считается — в вкладку должно уйти голое «/clear».
test('claudeLine собирает строку заново, без хвоста @бота', () => {
  assert.strictEqual(T.claudeLine({ command: 'clear', args: '' }), '/clear');
  assert.strictEqual(T.claudeLine({ command: 'compact', args: 'итоги по багу' }),
    '/compact итоги по багу');
  assert.strictEqual(T.claudeLine(T.readUpdate({
    update_id: 1,
    message: { message_id: 2, chat: { id: 5 }, from: { id: 7 }, text: '/clear@swarm_bot' },
  })), '/clear');
  assert.strictEqual(T.claudeLine({ command: '', args: 'x' }), '', 'нет команды — нечего печатать');
});

// Путь к «стереть» обязан идти через кнопку: своей команды у моста нет, а слэш в меню у поля
// ввода нажимается пальцем мимо соседнего.
test('у подтверждения /clear есть своя кнопка и она называет цену', () => {
  const flat = T.actionKeyboard('4', ['clear']).inline_keyboard.flat();
  assert.strictEqual(flat.length, 1);
  assert.deepStrictEqual(T.parseAction(flat[0].callback_data), { tab: '4', action: 'clear' });
  assert.match(T.QA_ACTIONS.clear, /стереть/i);
});

// В шапке темы её быть не должно — по той же причине, что и у «закрыть вкладку»: панель
// висит там всегда, и промах пальцем стоил бы всего разговора.
test('«стереть разговор» не попадает в постоянную панель темы', () => {
  assert.ok(!T.HEADER_ACTIONS.includes('clear'));
  assert.ok(!T.actionKeyboard('4').inline_keyboard.flat()
    .some((b) => /стереть/i.test(b.text)));
});

// --- живое «думаю…» -----------------------------------------------------------
// Заготовка висит весь ход, и неподвижные часики не отвечают на «работает или уснул?».
// Числа в ней — единственный ответ, доступный с телефона.

test('thinkingLine показывает время, инструмент, написанное и контекст', () => {
  const line = T.thinkingLine({
    elapsedMs: 4 * 60_000, tool: 'Bash', tokens: { out: 4600, inp: 310_000 },
    ctx: { pct: 38, total: '200K' }, clock: '17:58',
  });
  assert.strictEqual(line, '⏳ думаю 4 мин · Bash · написал 4.6K из 310K · контекст 38% из 200K · 17:58');
});

test('thinkingLine: чего не знаем, о том молчим — но время есть всегда', () => {
  assert.strictEqual(T.thinkingLine({ elapsedMs: 45_000 }), '⏳ думаю 45 с');
  // Вкладка без стенограммы не знает ни инструмента, ни токенов: пустой расход — не «0».
  assert.strictEqual(T.thinkingLine({ elapsedMs: 90_000, tokens: { out: 0, inp: 0 }, clock: '17:58' }),
    '⏳ думаю 2 мин · 17:58');
  assert.strictEqual(T.thinkingLine(), '⏳ думаю 0 с');
});

test('fmtSpan округляет крупно, а часы называет часами', () => {
  assert.strictEqual(T.fmtSpan(0), '0 с');
  assert.strictEqual(T.fmtSpan(59_400), '59 с');
  assert.strictEqual(T.fmtSpan(60_000), '1 мин');
  assert.strictEqual(T.fmtSpan(72 * 60_000), '1 ч 12 мин');
  assert.strictEqual(T.fmtSpan(120 * 60_000), '2 ч');
});

test('fmtTokens: тысячи, а не длинные числа', () => {
  assert.strictEqual(T.fmtTokens(940), '940');
  assert.strictEqual(T.fmtTokens(4600), '4.6K');
  assert.strictEqual(T.fmtTokens(310_000), '310K');
  assert.strictEqual(T.fmtTokens(2_400_000), '2.4M');
});

// Shift+Tab, которым Claude Code переключает режим разрешений: приложение должно посылать
// ровно то, что посылает терминал (CSI Z), иначе для Claude это будет не нажатие, а мусор.
test('BACK_TAB — это CSI Z, то есть настоящий Shift+Tab', () => {
  assert.strictEqual(T.BACK_TAB, '\x1b[Z');
});

// --- tagging the injected text ------------------------------------------------

test('tagInput: the first message carries the whole convention', () => {
  const out = T.tagInput({ text: 'сделай X', instruction: 'отвечай коротко', primed: false });
  assert.strictEqual(out, '[тлг: отвечай коротко] сделай X');
});

test('tagInput: later messages carry only the short tag', () => {
  assert.strictEqual(T.tagInput({ text: 'да, второй', instruction: 'отвечай коротко', primed: true }),
    '[тлг] да, второй');
});

test('tagInput: the tag stays on ONE line — a newline would submit early', () => {
  const out = T.tagInput({ text: 'x', instruction: 'коротко,\n  без кода' });
  assert.ok(!out.includes('\n'), out);
  assert.strictEqual(out, '[тлг: коротко, без кода] x');
});

test('tagInput: no instruction, or no text, still yields something sane', () => {
  assert.strictEqual(T.tagInput({ text: 'привет' }), '[тлг] привет');
  assert.strictEqual(T.tagInput({ text: '', instruction: 'коротко' }), '[тлг: коротко]');
});

// --- buttons under a permission request ---------------------------------------

test('inlineKeyboard offers exactly the options Claude gave, carrying tab + fingerprint', () => {
  const kb = T.inlineKeyboard([{ n: 1, text: 'Yes' }, { n: 2, text: 'No' }], '3', 'abc123');
  const flat = kb.inline_keyboard.flat();
  assert.deepStrictEqual(flat.map((b) => b.text), ['1. Yes', '2. No']);
  assert.deepStrictEqual(T.parseCallbackData(flat[1].callback_data), { tab: '3', fingerprint: 'abc123', n: 2 });
});

// Одна кнопка в ряд — всегда: подпись это единственное, что на кнопке видно, и делить
// ширину с соседом ей нельзя. Проверяем и на смеси длин, и на двух коротких, где соблазн
// поставить пару максимальный.
test('inlineKeyboard даёт каждому варианту свой ряд целиком', () => {
  const kb = T.inlineKeyboard([
    { n: 1, text: 'Yes' }, { n: 2, text: 'Yes, and don\'t ask again for rm commands' }, { n: 3, text: 'No' },
  ], '3', 'abc123');
  assert.deepStrictEqual(kb.inline_keyboard.map((r) => r.length), [1, 1, 1],
    JSON.stringify(kb.inline_keyboard));
  assert.strictEqual(kb.inline_keyboard[1][0].callback_data, 'p|3|abc123|2');
});

test('inlineKeyboard не ставит парой даже «Yes» и «No»', () => {
  const kb = T.inlineKeyboard([{ n: 1, text: 'Yes' }, { n: 2, text: 'No' }], '3', 'abc123');
  assert.deepStrictEqual(kb.inline_keyboard.map((r) => r.length), [1, 1],
    JSON.stringify(kb.inline_keyboard));
});

// Кнопка в Telegram — одна строка фиксированной высоты, переносов в ней нет. Значит
// длинную подпись всё равно обрежут; вопрос лишь в том, мы это сделаем или клиент молча
// посреди слова.
test('buttonLabel оставляет короткую подпись как есть', () => {
  assert.strictEqual(T.buttonLabel(1, 'Yes'), '1. Yes');
});

test('buttonLabel режет длинную подпись по границе слова и помечает обрезку', () => {
  const label = T.buttonLabel(2, "Yes, and don't ask again for rm commands in this project");
  assert.ok(label.length <= T.BTN_MAX, label);
  assert.ok(label.endsWith('…'), label);
  assert.ok(label.startsWith('2. Yes'), label);
  // По слову, а не посреди него: перед многоточием — целое слово.
  assert.ok(!/\s…$/.test(label), label);
  assert.ok("Yes, and don't ask again for rm commands in this project".startsWith(
    label.slice(3, -1)), label);
});

test('buttonLabel рубит по символу, когда первое слово само длиннее кнопки', () => {
  const label = T.buttonLabel(3, 'A'.repeat(80));
  assert.ok(label.length <= T.BTN_MAX, label);
  assert.ok(label.startsWith('3. AAA'), label);   // не «3. …»
});

test('optionsList печатает варианты полностью, номерами Клода', () => {
  const list = T.optionsList([{ n: 1, text: 'Yes' }, { n: 2, text: 'No, and tell Claude what to do' }]);
  assert.strictEqual(list, '1. Yes\n2. No, and tell Claude what to do');
  assert.strictEqual(T.optionsList(null), '');
});

test('inlineKeyboard кладёт на кнопку обрезанную подпись, а полный текст оставляет списку', () => {
  const long = "Yes, and don't ask again for rm commands in this project";
  const kb = T.inlineKeyboard([{ n: 1, text: 'Yes' }, { n: 2, text: long }], '3', 'abc123');
  const flat = kb.inline_keyboard.flat();
  assert.strictEqual(flat[1].text, T.buttonLabel(2, long));
  assert.ok(T.optionsList([{ n: 2, text: long }]).includes(long));
});

test('inlineKeyboard drops an option it cannot address, and nothing means no keyboard', () => {
  const huge = 'f'.repeat(T.CB_MAX);
  assert.strictEqual(T.inlineKeyboard([{ n: 1, text: 'Yes' }], '3', huge), null);
  assert.strictEqual(T.inlineKeyboard([], '3', 'abc'), null);
  assert.strictEqual(T.inlineKeyboard(null, '3', 'abc'), null);
});

test('callbackData stays inside Telegram’s 64-byte limit', () => {
  assert.ok(T.callbackData('12', 'zzzzzzz', 3).length <= T.CB_MAX);
});

test('parseCallbackData rejects anything that is not ours', () => {
  for (const junk of ['', 'x|3|abc|1', 'p|3|abc', 'p||abc|1', 'p|3|abc|0', 'p|3|abc|нет', null]) {
    assert.strictEqual(T.parseCallbackData(junk), null, String(junk));
  }
});

test('readUpdate turns a tapped button into a routable callback', () => {
  const u = T.readUpdate({
    update_id: 7,
    callback_query: {
      id: 'q1', data: 'p|3|abc123|2', from: { id: 42 },
      message: { message_id: 9, is_topic_message: true, message_thread_id: 5, chat: { id: -100123 } },
    },
  });
  assert.strictEqual(u.kind, 'callback');
  assert.strictEqual(u.callbackId, 'q1');
  assert.strictEqual(u.chatId, -100123);
  assert.strictEqual(u.threadId, 5, 'the topic must survive: it is still the routing key');
  assert.strictEqual(u.data, 'p|3|abc123|2');
});

test('the poller subscribes to button taps, not just messages', async () => {
  const h = harness([okUpdates([])]);
  await h.poller.start();
  // my_chat_member — чтобы «бота выгнали из группы» не выглядело как «мост в эфире».
  assert.deepStrictEqual(h.calls[0].body.allowed_updates,
    ['message', 'callback_query', 'my_chat_member']);
});

// --- outbound text -----------------------------------------------------------

test('chunkText leaves a short message alone', () => {
  assert.deepStrictEqual(T.chunkText('коротко'), ['коротко']);
  assert.deepStrictEqual(T.chunkText(''), []);
});

test('chunkText splits on a paragraph boundary when it can', () => {
  const parts = T.chunkText('a'.repeat(30) + '\n\n' + 'b'.repeat(30), 40);
  assert.strictEqual(parts.length, 2);
  assert.strictEqual(parts[0], 'a'.repeat(30));
  assert.strictEqual(parts[1], 'b'.repeat(30));
});

test('chunkText never exceeds the cap, even with no break to use', () => {
  for (const p of T.chunkText('я'.repeat(200), 40)) assert.ok(p.length <= 40, p.length);
});

// --- retry pacing ------------------------------------------------------------

test('backoff grows and is capped', () => {
  assert.ok(T.backoffMs(0) < T.backoffMs(3));
  assert.strictEqual(T.backoffMs(99), T.BACKOFF_MAX_MS);
});

test("Telegram's own retry_after wins over our backoff", () => {
  assert.strictEqual(T.retryAfterMs({ parameters: { retry_after: 7 } }), 7000);
  assert.strictEqual(T.retryAfterMs({}), 0);
});

test('classifyError: a bad token and a rival poller are terminal, network is not', () => {
  assert.strictEqual(T.classifyError(401, {}).fatal, true);
  assert.strictEqual(T.classifyError(409, {}).reason, 'conflict');
  assert.strictEqual(T.classifyError(409, {}).fatal, true);
  assert.strictEqual(T.classifyError(0, {}).fatal, false);
  assert.strictEqual(T.classifyError(429, {}).fatal, false);
});

// Отказ из-за разметки надо отличать от любого другого: на него мост переотправляет то же
// сообщение без разметки (см. tgSend), а на «нет такого чата» переотправлять нечего и незачем.
// Формулировок у телеги несколько, и промах здесь означает потерянный ответ агента.
test('entityError узнаёт отказ именно про разметку', () => {
  assert.strictEqual(T.entityError({ description: "Bad Request: can't parse entities: Unsupported start tag \"b\" at byte offset 10" }), true);
  assert.strictEqual(T.entityError({ description: 'Bad Request: can\'t find end of the entity starting at byte offset 42' }), true);
  assert.strictEqual(T.entityError({ description: 'Bad Request: Unmatched end tag at byte offset 7' }), true);
  assert.strictEqual(T.entityError({ description: 'Bad Request: chat not found' }), false);
  assert.strictEqual(T.entityError({ description: 'Bad Request: message thread not found' }), false);
  assert.strictEqual(T.entityError({}), false);
  assert.strictEqual(T.entityError(null), false);
});

// --- the poll loop -----------------------------------------------------------
// A fake fetch replays scripted responses; `sleep` records what the loop asked to wait
// instead of actually waiting, and stops the loop once the script runs out.

function harness(script) {
  const calls = [];
  const seen = [];
  const states = [];
  const slept = [];
  let i = 0;
  const poller = T.createPoller({
    token: TOKEN,
    fetchJson: async (url, body) => {
      calls.push({ url, body });
      const step = script[i++];
      if (!step) { poller.stop(); return { ok: true, status: 200, body: { ok: true, result: [] } }; }
      if (step.throw) throw new Error(step.throw);
      return step;
    },
    sleep: async (ms) => { slept.push(ms); },
    onUpdate: (u) => seen.push(u),
    onState: (s) => states.push(s),
  });
  return { poller, calls, seen, states, slept };
}

const okUpdates = (result) => ({ ok: true, status: 200, body: { ok: true, result } });

test('poller advances the offset past every update it handled', async () => {
  const h = harness([okUpdates([msgUpdate({}), { update_id: 11, message: msgUpdate({}).message }])]);
  await h.poller.start();
  assert.strictEqual(h.seen.length, 2);
  assert.strictEqual(h.poller.offset, 12, 'offset must be last update_id + 1');
  assert.strictEqual(h.calls[1].body.offset, 12, 'and be sent on the next poll');
});

test('poller keeps going when a handler throws (the update is not replayed)', async () => {
  const calls = [];
  let i = 0;
  const script = [okUpdates([msgUpdate({})])];
  const poller = T.createPoller({
    token: TOKEN,
    fetchJson: async (url, body) => {
      calls.push(body);
      const step = script[i++];
      if (!step) { poller.stop(); return okUpdates([]); }
      return step;
    },
    sleep: async () => {},
    onUpdate: () => { throw new Error('handler exploded'); },
  });
  await poller.start();
  assert.strictEqual(calls[1].offset, 11, 'moved on despite the throw');
});

test('poller stops for good on a fatal error (bad token)', async () => {
  const h = harness([{ ok: false, status: 401, body: { ok: false, description: 'Unauthorized' } }]);
  await h.poller.start();
  assert.strictEqual(h.calls.length, 1, 'no retry after a fatal error');
  assert.strictEqual(h.states[0].error.reason, 'unauthorized');
  assert.strictEqual(h.poller.alive, false);
});

test('poller backs off on a network failure and comes back', async () => {
  const h = harness([{ throw: 'ENOTFOUND api.telegram.org' }, okUpdates([])]);
  await h.poller.start();
  assert.ok(h.slept[0] >= 1000, 'waited before retrying: ' + h.slept[0]);
  assert.strictEqual(h.states[0].error.reason, 'network');
  assert.ok(h.calls.length >= 2, 'retried');
});

test('poller reports recovery once, not on every successful poll', async () => {
  const h = harness([{ throw: 'offline' }, okUpdates([]), okUpdates([])]);
  await h.poller.start();
  const recoveries = h.states.filter((s) => s.ok === true && !s.handlerError);
  assert.strictEqual(recoveries.length, 1, JSON.stringify(h.states));
});

test('poller obeys retry_after on a flood wait', async () => {
  const h = harness([{ ok: false, status: 429, body: { ok: false, parameters: { retry_after: 3 } } }, okUpdates([])]);
  await h.poller.start();
  assert.strictEqual(h.slept[0], 3000);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; }
    catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
  }
  console.log(passed + '/' + tests.length + ' telegram tests passed');
})();
