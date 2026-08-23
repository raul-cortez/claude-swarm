'use strict';
// The Telegram side of the bridge: URLs, token shape, update parsing, the long-poll
// loop. Deliberately knows nothing about Electron, sessions or the detector — main.js
// wires it to those — so all of it is testable in plain node with a fake fetch.
//
// LONG POLLING, not a webhook. The app calls out to api.telegram.org and nothing
// listens on this machine: no open port, no public URL, no VPS. The flip side is the
// one real external dependency of the whole feature — if Telegram only works here
// through a VPN, this does too, and there is no local fallback that changes that.
//
// Long polling also means exactly ONE reader per bot token. Two swarms (or a swarm and
// some other bot code) on the same token fight over getUpdates and Telegram answers 409
// — surfaced as a plain «этот токен уже читает кто-то другой», not a silent stall.

const API_HOST = 'https://api.telegram.org';

function apiUrl(token, method) {
  return `${API_HOST}/bot${token}/${method}`;
}

// --- the token ---------------------------------------------------------------
// BotFather hands out `<bot id>:<secret>`. Checking the shape before we ever send it
// means a pasted chunk of BotFather's message, or a copy that lost its tail, fails in
// the settings box where the user can see it — instead of turning into a 401 later.
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

function looksLikeToken(s) {
  return TOKEN_RE.test(String(s == null ? '' : s).trim());
}

// For showing that a token is stored without showing the token. The bot id is public
// (it's the first half of any bot's username lookup), the secret never appears.
function maskToken(s) {
  const t = String(s == null ? '' : s).trim();
  const i = t.indexOf(':');
  if (i < 1) return '';
  return t.slice(0, i) + ':' + '•'.repeat(6) + t.slice(-4);
}

// --- pairing -----------------------------------------------------------------
// The app never asks anyone to find their chat id. It shows a one-time code, the user
// sends it to their bot (by scanning a deep link, or by typing it), and the chat that
// brought the code is the chat we bind to. Ambient noise — someone else stumbling onto
// the bot — can't bind, because it doesn't know the code.
//
// Unambiguous alphabet: no 0/O/1/I/l, so a code read off a screen can't be mistyped
// into a different valid code.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;

function pairCode(randomInt) {
  const rnd = typeof randomInt === 'function'
    ? randomInt
    : (n) => Math.floor(Math.random() * n);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[rnd(CODE_ALPHABET.length) % CODE_ALPHABET.length];
  return out;
}

// `t.me/<bot>?start=<code>` opens a private chat with the bot and pre-fills the /start;
// `?startgroup=` offers to add the bot to a group instead (that's the path to a forum
// supergroup, where each tab gets its own topic). Both deliver the same code back to us.
function deepLink(botUsername, code, opts) {
  const user = String(botUsername || '').replace(/^@/, '');
  const key = opts && opts.group ? 'startgroup' : 'start';
  return `https://t.me/${user}?${key}=${encodeURIComponent(code)}`;
}

// Does this update carry our pairing code? Accepts it from a private chat and from a
// group alike: `/start CODE`, `/start@mybot CODE`, or the bare code typed by hand.
function pairingMatch(msg, code) {
  if (!msg || !code) return false;
  const want = String(code).trim().toUpperCase();
  const text = String(msg.text || '').trim().toUpperCase();
  if (!text) return false;
  const m = text.match(/^\/START(?:@\S+)?\s*(\S+)?$/);
  const given = m ? (m[1] || '') : text;
  return given === want;
}

// --- updates -----------------------------------------------------------------
// One shape for the rest of the app, whatever Telegram sent. Everything we route on is
// here: the chat, the forum topic, who wrote it, the text, and the message it replies
// to — the reply is the routing key, so it survives into `replyToId`.
function readUpdate(u) {
  if (!u || typeof u !== 'object') return null;
  // A tapped button. Its `message` is the one the keyboard hangs on, so the chat and the
  // topic come from there — the same routing keys a plain message has.
  if (u.callback_query) {
    const q = u.callback_query;
    const m = q.message || {};
    const chat = m.chat || {};
    const qf = q.from || {};
    return {
      updateId: u.update_id,
      kind: 'callback',
      callbackId: q.id,
      data: String(q.data || ''),
      fromId: qf.id,
      // Имя нужно и здесь, а не только у сообщений: нажатие кнопки разрешения — самое
      // весомое действие моста, и в журнале должно быть видно, КТО его сделал.
      fromName: [qf.first_name, qf.last_name].filter(Boolean).join(' ') || qf.username || '',
      chatId: chat.id,
      threadId: m.is_topic_message ? (m.message_thread_id || null) : null,
      messageId: m.message_id,
      text: String(m.text || ''),
    };
  }
  // Бота выгнали из группы или разжаловали. Узнать об этом иначе нечем: пока никто не
  // напишет, мост считает себя живым — и панель настроек показывает зелёное «в эфире» уже
  // после того, как в группе его нет.
  if (u.my_chat_member) {
    const m = u.my_chat_member;
    return {
      updateId: u.update_id,
      kind: 'membership',
      chatId: (m.chat || {}).id,
      status: String((m.new_chat_member || {}).status || ''),
      fromId: (m.from || {}).id,
      fromName: [(m.from || {}).first_name, (m.from || {}).last_name].filter(Boolean).join(' ')
        || (m.from || {}).username || '',
    };
  }
  // Только `message`. Правки чужих сообщений мы у Telegram не запрашиваем (allowed_updates
  // в createPoller), и это осознанно: текст, уже напечатанный в живую сессию, отредактировать
  // задним числом нельзя, а прислать его вторым — значит выполнить задачу дважды.
  const msg = u.message || null;
  if (!msg) return { updateId: u.update_id, kind: 'other', msg: null };
  const from = msg.from || {};
  const chat = msg.chat || {};
  const service = readService(msg);
  const text = typeof msg.text === 'string' ? msg.text
    : typeof msg.caption === 'string' ? msg.caption : '';
  const cmd = text.match(/^\/([A-Za-z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/);
  const photo = readPhoto(msg);
  return {
    updateId: u.update_id,
    kind: 'message',
    messageId: msg.message_id,
    chatId: chat.id,
    chatType: chat.type || '',
    isForum: !!chat.is_forum,
    // Forum topics: `message_thread_id` is the topic. Telegram also sets it on plain
    // replies inside a topic, which is exactly what we want — same tab either way.
    // У служебных записей форума (тему переименовали, закрыли) is_topic_message не всегда
    // выставлен, а тема у них есть всегда — иначе событие некуда отнести.
    threadId: (msg.is_topic_message || service) ? (msg.message_thread_id || null) : null,
    service,
    fromId: from.id,
    fromName: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || '',
    text,
    command: cmd ? cmd[1].toLowerCase() : null,
    args: cmd ? String(cmd[2] || '').trim() : '',
    replyToId: msg.reply_to_message ? msg.reply_to_message.message_id : null,
    // A voice note / audio: phase two transcribes it. Carried through now so the
    // bridge can answer «голос пока не умею» instead of silently ignoring it.
    voice: msg.voice ? { fileId: msg.voice.file_id, seconds: msg.voice.duration || 0 } : null,
    photo,
    // Всё остальное вложенное — чтобы ответить «этого пока не умею» вместо тишины. Про
    // картинку тут молчим: она уже разобрана выше и уйдёт агенту файлом.
    media: photo ? null : mediaKind(msg),
    raw: msg,
  };
}

// --- картинки ------------------------------------------------------------------
// Скриншот с телефона — самый естественный способ показать агенту, что стряслось: набирать
// текст ошибки пальцем никто не станет. Claude Code читает картинки с диска, поэтому мосту
// нужен только файл: он его скачивает и отдаёт агенту путь (см. tgOnPhoto в main.js).
//
// Два вида, и оба настоящие: `photo` — обычная отправка (Telegram пережимает и отдаёт
// лесенку размеров, берём самый крупный, он последний), `document` с картиночным mime —
// отправка «как файл», которой пользуются, когда важны пиксели, а не вес. Второй случай не
// экзотика: на iOS «сохранить качество» шлёт именно так, и без него скриншот кода приходил
// бы замыленным до нечитаемости.
function readPhoto(msg) {
  const sizes = Array.isArray(msg.photo) ? msg.photo.filter(Boolean) : [];
  if (sizes.length) {
    const best = sizes[sizes.length - 1];
    return { fileId: best.file_id, name: '', bytes: Number(best.file_size) || 0 };
  }
  const doc = msg.document;
  if (doc && /^image\//i.test(String(doc.mime_type || ''))) {
    return { fileId: doc.file_id, name: String(doc.file_name || ''), bytes: Number(doc.file_size) || 0 };
  }
  return null;
}

// Вложение, с которым мост ничего сделать не может. Название нужно в винительном падеже:
// оно подставляется в «прислал(а) …, а я такое пока не умею» — фраза читается человеком, и
// «прислал видео» против «прислал видеокружок» здесь важнее краткости кода.
const MEDIA_LABELS = {
  document: 'файл',
  video: 'видео',
  video_note: 'видеокружок',
  audio: 'аудиофайл',
  animation: 'гифку',
  sticker: 'стикер',
  location: 'геометку',
  contact: 'контакт',
  poll: 'опрос',
};

function mediaKind(msg) {
  for (const k of Object.keys(MEDIA_LABELS)) if (msg && msg[k]) return k;
  return null;
}

function mediaLabel(kind) {
  return MEDIA_LABELS[kind] || 'это';
}

// --- служебные записи форума ---------------------------------------------------
// Тему переименовали или закрыли ПАЛЬЦАМИ в телеге — Telegram сообщает об этом обычным
// message-обновлением: текста нет, вместо него поле forum_topic_*. Другого способа узнать
// об этом у бота нет (методов «прочитать список тем» в Bot API не существует), поэтому без
// разбора этих записей синхронизация возможна только в одну сторону — из сворма в телегу.
// Именно так и было: вкладку переименовали на маке — тема поехала следом, а обратно нет.
//
// forum_topic_edited приходит и на НАШ собственный editForumTopic — то есть эхо. Отличать
// его от чужого переименования должен вызывающий (сравнением с текущим именем вкладки):
// здесь мы только честно говорим, что случилось.
function readService(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.forum_topic_created) {
    return { kind: 'topic-created', name: String(msg.forum_topic_created.name || '') };
  }
  if (msg.forum_topic_edited) {
    // Сменили одну иконку — имени в записи нет вовсе, и переносить нечего. Пустая строка
    // именем не считается: вкладка без имени — это вкладка, которую не позвать.
    const name = msg.forum_topic_edited.name;
    return { kind: 'topic-edited', name: typeof name === 'string' && name.trim() ? name.trim() : null };
  }
  if (msg.forum_topic_closed) return { kind: 'topic-closed' };
  if (msg.forum_topic_reopened) return { kind: 'topic-reopened' };
  return null;
}

// Кто написал или нажал — для журнала моста. Имя читается человеком, id различает: в группе
// бывают два Саши, а разбор «коллега жалуется, что бот не ответил» упирался в то, что автора
// в журнале не было вовсе, и приходилось искать по косвенным признакам.
//
// Имени может не быть (у аккаунта нет ни имени, ни username), id — есть всегда: тогда в
// журнал идёт он один. Пустой скобки за именем не оставляем — строку читают глазами.
function senderLabel(u) {
  const name = String((u && u.fromName) || '').replace(/\s+/g, ' ').trim();
  const id = u && u.fromId != null ? String(u.fromId) : '';
  if (name && id) return `${name} (${id})`;
  return name || id || '?';
}

// --- routing -----------------------------------------------------------------
// WHICH tab does this message answer? The dangerous failure here isn't «no route», it's
// the WRONG route: «да, вариант 2» typed into another agent's task. So only explicit
// evidence counts, and there is deliberately no «last active tab» guess:
//
//   1. the forum topic the message sits in — one topic per tab, which is the whole shape
//      of the bridge: the group's topic list IS the tab list;
//   2. the message it replies to — kept because replying inside a topic is natural, and
//      because it still names a tab exactly.
//
// A topic mapped in an earlier run is re-attached through the tab's persistent key, so
// answering in an old topic after a relaunch reaches the same tab, not its neighbour.
// A message in the group's General topic (no threadId, no reply) names no tab at all —
// that's the control channel, not a session.
// `ctx`: { topicSession: Map, sent: Map, topics: {tabKey→threadId}, tabs: [{id, tabKey}],
//          alive: (id)=>boolean }
function routeMessage(u, ctx) {
  if (!u) return null;
  const c = ctx || {};
  const alive = typeof c.alive === 'function' ? c.alive : () => true;
  const get = (m, k) => (m && typeof m.get === 'function' ? m.get(k) : undefined);

  if (u.threadId != null) {
    const byTopic = get(c.topicSession, u.threadId);
    if (byTopic != null && alive(byTopic)) return byTopic;
    const topics = c.topics || {};
    const key = Object.keys(topics).find((k) => topics[k] === u.threadId);
    if (key) {
      const tab = (c.tabs || []).find((t) => t && t.tabKey === key && alive(t.id));
      if (tab) return tab.id;
    }
    // A topic we don't know is NOT a reason to fall through to the reply chain of some
    // other tab — but a reply inside it is still explicit, so let that be checked below.
  }
  if (u.replyToId != null) {
    const byReply = get(c.sent, u.replyToId);
    if (byReply != null && alive(byReply)) return byReply;
  }
  return null;
}

// --- telling the agent where the question came from ---------------------------
// A phone is not a terminal: a page of code, a list of file paths or an interactive
// «choose 1/2/3» is useless there. The agent can only adapt if it KNOWS, so every line
// injected from Telegram is tagged.
//
// The first message of a session carries the whole convention; later ones carry a short
// tag. Not decoration: after a context compaction the convention can fall out of
// context, and the tag re-anchors it. It also makes provenance visible — sitting at the
// Mac you can see in the scrollback which instructions arrived from the phone.
const TG_TAG = 'тлг';

// --- сколько подробностей присылать -------------------------------------------
// «Кратко или полностью» — это НЕ обрезка нашего сообщения постфактум, а инструкция
// самому агенту: краткость в телеге всегда делалась этой строкой, и она же остаётся
// местом, где ей управляют. Обрезать готовый ответ было бы хуже — человек видел бы
// оборванную мысль вместо мысли, изложенной коротко.
//
// short — то, с чем мост жил с самого начала (и остаётся по умолчанию).
// full  — для тех, кто читает с телефона всерьёз: те же запреты на интерактивный выбор
//         (в чате его нечем нажать), но без требования ужимать содержание.
const PROMPTS = {
  short: 'из Telegram — отвечай коротко, текстом на телефон: без длинных'
    + ' блоков кода и путей к файлам, без вариантов с выбором клавиатурой, вопросы задавай прозой',
  full: 'из Telegram — отвечай полно, как за компьютером, но текстом на телефон:'
    + ' без вариантов с выбором клавиатурой, вопросы задавай прозой',
};

// Третье положение — своя формулировка человека. Оно здесь, а не кнопкой рядом с двумя
// заготовками, по простой причине: своя формулировка ОТМЕНЯЕТ обе, то есть это тот же самый
// выбор, а не добавка к нему. Кнопкой сбоку выходило нечестно — «кратко» стояло выбранным,
// а в силе была чужая строка.
//
// Текста у 'custom' здесь нет намеренно: он живёт в настройках моста (TG.prompt), а этот
// модуль чистый. Пусто — заготовка «кратко»: положение выбрано, а сказать пока нечего.
const DETAILS = ['short', 'full', 'custom'];

function detailPrompt(detail) {
  return PROMPTS[detail] || PROMPTS.short;
}

// --- живое «думаю…» ------------------------------------------------------------
// Заготовка ответа висит в чате всё время хода, а ход бывает и на десять минут. Часики,
// которые не меняются, отвечают на «работает или уснул?» ровно ничем — а вопрос этот с
// телефона главный: до мака не дотянуться, чтобы посмотреть самому.
//
// Поэтому в заготовку раз в полминуты вписываются живые числа. Все они уже есть у
// приложения (стенограмма и снимок статуслайна), так что стоят они одного запроса на
// правку сообщения — не опроса, не подсчёта, не лишнего процесса.
//
// Время округляем крупно: разница между «4 мин» и «4 мин 12 с» не значит ничего, а
// секундная стрелка в чате только притворяется точностью.
function fmtSpan(ms) {
  const s = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  if (s < 60) return `${Math.round(s)} с`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} ч ${rest} мин` : `${h} ч`;
}

// Токены — тысячами: точное число здесь не решение, а шум, и на узком экране оно съедает
// строку, в которой всё остальное важнее.
function fmtTokens(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 1e6) return (v / 1000).toFixed(v < 10_000 ? 1 : 0).replace('.0', '') + 'K';
  return (v / 1e6).toFixed(1).replace('.0', '') + 'M';
}

// Строка заготовки. Всё, кроме времени, необязательно: вкладка без стенограммы не знает ни
// инструмента, ни токенов, и врать о них нечем — тогда в строке останется время и часы, а
// это уже отвечает на «жив ли он», потому что меняется.
//
//   { elapsedMs, tool, tokens: {out, inp}, ctx: {pct, total}, clock }
function thinkingLine(info) {
  const i = info || {};
  const parts = [`⏳ думаю ${fmtSpan(i.elapsedMs)}`];
  if (i.tool) parts.push(i.tool);
  if (i.tokens && i.tokens.out > 0) {
    const inp = i.tokens.inp > 0 ? ` из ${fmtTokens(i.tokens.inp)}` : '';
    parts.push(`написал ${fmtTokens(i.tokens.out)}${inp}`);
  }
  if (i.ctx && i.ctx.pct != null) {
    parts.push(`контекст ${i.ctx.pct}%${i.ctx.total ? ' из ' + i.ctx.total : ''}`);
  }
  if (i.clock) parts.push(i.clock);
  return parts.join(' · ');
}

function tagInput(opts) {
  const o = opts || {};
  const text = String(o.text == null ? '' : o.text).trim();
  const instruction = String(o.instruction || '').replace(/\s+/g, ' ').trim();
  const head = !o.primed && instruction ? `[${TG_TAG}: ${instruction}]` : `[${TG_TAG}]`;
  return text ? `${head} ${text}` : head;
}

// Почему адресат не определился. Нужно, чтобы отказ не врал: раньше на любое «не знаю»
// уходило «это общая тема», в том числе когда человек писал в НАСТОЯЩУЮ тему вкладки. Это
// худший вид сообщения об ошибке — оно уверенно называет неверную причину, и человек идёт
// искать несуществующую проблему.
//
//   general      — сообщение вне тем (в форуме это General): адресата и правда нет
//   topic-closed — тема есть в карте, но её вкладка уже не живая
//   topic-alien  — тема нам неизвестна: карта потерялась или тему создали руками
function routeFailure(u, ctx) {
  const c = ctx || {};
  if (!u || u.threadId == null) return 'general';
  const topics = c.topics || {};
  return Object.keys(topics).some((k) => topics[k] === u.threadId) ? 'topic-closed' : 'topic-alien';
}

// --- как текст попадает в pty -------------------------------------------------
// Раздельно: сначала текст, ПОТОМ Enter отдельной записью. Одним куском `текст\r` не
// работает — Claude Code считает крупный быстрый ввод вставкой, и хвостовой возврат
// каретки уходит в буфер как перевод строки внутри текста. Снаружи это выглядит так:
// сообщение из телеги появилось в поле ввода и там осталось. Человек за маком жмёт Enter
// руками — и этим снимает с вкладки режим «отвечаем в телегу», так что итог хода уже
// никуда не уезжает. Один пропущенный Enter выключает половину моста.
//
// Многострочный текст оборачивается в bracketed paste (то, что присылает терминал при
// вставке из буфера): без этого первый же перевод строки отправляет сообщение, и половина
// уезжает агенту, а остаток печатается сверху как следующее.
const PASTE_ON = '\x1b[200~';
const PASTE_OFF = '\x1b[201~';
const ENTER = '\r';

// Shift+Tab — то, чем Claude Code переключает режим разрешений. В терминале это CSI Z
// (обратный табулятор): именно его посылает терминал, когда жмут Shift+Tab, поэтому для
// приложения нажатие из телеги ничем не отличается от нажатия за клавиатурой.
const BACK_TAB = '\x1b[Z';

// Escape — «закрыть диалог, ничего не выбрав». Тем же байтом это делает клавиатура, поэтому
// для Claude Code нажатие из телеги неотличимо от нажатия за компьютером. См. QA_ACTIONS.esc.
const ESC = '\x1b';

function inputWrites(text) {
  const body = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (!body) return [];
  return [body.includes('\n') ? PASTE_ON + body + PASTE_OFF : body, ENTER];
}

// --- buttons under a permission request ---------------------------------------
// One button per option Claude offered, and nothing else: the payload carries the option
// NUMBER, so tapping can only ever choose from that list. It also carries the tab and the
// prompt's fingerprint, because by the time you tap, that prompt may be gone — main
// re-checks both before typing anything (see the plan: «одобряешь то, что видишь»).
//
// callback_data is capped at 64 bytes by Telegram, so the payload is deliberately terse:
//   p|<tab id>|<fingerprint>|<option number>
const CB_PREFIX = 'p';
const CB_MAX = 64;

// --- быстрые действия: команды одним касанием ---------------------------------
// Список для кнопки «Меню» у поля ввода (setMyCommands): с телефона набирать «/mode auto»
// неудобно, а в меню это выбор из списка с описанием.
const COMMANDS = [
  { command: 'tabs', description: 'вкладки и кто чем занят' },
  { command: 'last', description: 'что агент сказал последним' },
  { command: 'phone', description: 'я с телефоном: писать сюда обо всём, маку не спать' },
  { command: 'comp', description: 'я за компьютером: молчать и в вкладки не писать' },
  { command: 'night', description: 'меня нет: все вкладки решают сами, разрешения стоят' },
  { command: 'auto', description: 'эта вкладка работает без меня (в её теме)' },
  { command: 'morning', description: 'отчёт: кто стоит и что решили без меня' },
  { command: 'usage', description: 'расход: контекст вкладки, 5 часов, неделя' },
  { command: 'mode', description: 'режим вкладки: auto, edits, plan, manual' },
  { command: 'new', description: 'ещё один агент в папке этой темы' },
  { command: 'sync', description: 'привести темы в соответствие с вкладками' },
  { command: 'help', description: 'что я умею' },
];

// --- команды самого Клода ------------------------------------------------------
// Свои команды у моста наперечёт — всё остальное со слэшем принадлежит Клоду, и мост тут не
// исполнитель, а пальцы: печатает строку в живую вкладку и жмёт Enter. Для Claude Code это
// неотличимо от набора за клавиатурой, поэтому с телефона работает и /clear, и /compact, и
// личная команда из ~/.claude/commands, о существовании которой мост знать не может.
//
// Значит этот список обязан быть ПОЛНЫМ: своя команда, забытая в нём, уедет в вкладку и
// откроется там меню Клода вместо того, что человек просил.
const OWN_COMMANDS = new Set(COMMANDS.map((c) => c.command).concat(['start']));

function isOwnCommand(name) { return OWN_COMMANDS.has(String(name == null ? '' : name).toLowerCase()); }

// Три штуки в меню у поля ввода — те, за которыми с телефона тянутся чаще всего. Остальные
// пробрасываются и без меню: список здесь для одного касания, а не для разрешения.
const CLAUDE_COMMANDS = [
  { command: 'clear', description: 'Клоду: стереть разговор вкладки и начать с чистого' },
  { command: 'compact', description: 'Клоду: сжать контекст (можно сказать, что сохранить)' },
  { command: 'context', description: 'Клоду: чем занят контекст' },
];

const MENU_COMMANDS = COMMANDS.concat(CLAUDE_COMMANDS);

// Строка, которую напечатаем в вкладку. Собирается ЗАНОВО, а не берётся текстом сообщения:
// в группе Telegram дописывает к команде из меню «@имя_бота» («/clear@swarm_bot»), и такую
// строку Claude Code командой уже не считает.
//
// Пометка «[из телеги]» к ней не приписывается, в отличие от прозы (см. tagInput): строка
// обязана начинаться со слэша, иначе это не команда, а слова о команде.
function claudeLine(u) {
  const name = String((u && u.command) || '').toLowerCase();
  if (!name) return '';
  const args = String((u && u.args) || '').trim();
  return args ? `/${name} ${args}` : `/${name}`;
}

// Кнопки под шапкой темы. ПРЕФИКС ДРУГОЙ, чем у разрешений («p»), и это главное здесь:
// разбор строго раздельный, поэтому нажатие быстрой кнопки не может быть истолковано как
// выбор варианта в диалоге разрешения — там номер печатается в живую сессию, и спутать эти
// два вида кнопок было бы худшей ошибкой моста.
const QA_PREFIX = 'q';
// Подписи обязаны называть ЦЕНУ нажатия, поэтому «правки» и «авто» — разные кнопки: в живом
// Claude Code это разные режимы (accept edits разрешает только правки, auto судит каждое
// действие сам), и обещать одно, делая другое, тут нельзя.
//
// И в обратную сторону тоже: здесь стояло «⚡ вообще без вопросов», а auto в 2.1.220 всё
// равно спрашивает на опасном — разрушительный git, необратимое удаление, деплой, секреты
// (65 категорий, `claude auto-mode defaults`). Человек нажимал «вообще без вопросов», через
// минуту получал запрос разрешения и решал, что режим не переключился. Подпись, обещающая
// больше, чем есть, — такая же ложь про цену, как и та, что обещает меньше.
const QA_ACTIONS = {
  status: 'что сейчас',
  edits: '✍️ правки без спроса',
  auto: '⚡ авто — сам решает',
  manual: '🔒 спрашивать разрешение',
  new: '➕ ещё агент здесь',
  // Выход из тупика. Диалог на экране запирает вкладку: словами в него не ответить (одобряют
  // только то, что предложил Клод), а кнопок с вариантами не будет, если разобрать их не
  // удалось — и тогда с телефона нельзя ни выбрать, ни написать. Так живой квиз (вопрос с
  // вариантами, у каждого своё описание) оставил человека без единого действия: сворм отвечал
  // «выбери вариант кнопкой» на сообщение, под которым кнопок нет.
  //
  // Escape закрывает любой диалог Клода, ничего не одобряя, — это и есть безопасный выход:
  // после него вкладка снова принимает прозу.
  esc: '⎋ закрыть диалог',
  // «Сворм в режиме компа» — единственный выход из отказа принять сообщение (см. tgDeskHold в
  // main.js). Писать в вкладку можно только с телефона, поэтому у отказа обязана быть кнопка,
  // которая эту дверь и открывает: набирать /phone руками, чтобы отправить то, что уже
  // написано, — работа, придуманная приложением для человека.
  phone: '📱 включить режим телефона',
  // Подтверждение /clear. Стереть разговор — необратимо, а слэш с телефона слишком легко
  // нажать промахом по меню у поля ввода: там команды идут списком в один палец шириной, и
  // «/clear» стоит рядом с «/comp». Поэтому команда сама ничего не стирает — она спрашивает,
  // а стирает вот эта кнопка. Живёт она недолго (см. TG_CLEAR_TTL_MS в main.js): кнопка из
  // вчерашней ленты не должна доставать до сегодняшнего разговора.
  clear: '🧹 да, стереть разговор',
  // Две последние — только для сообщения «тему закрыли, а вкладка жива» (см. main.js).
  // В шапку темы они не попадают: там свой список, HEADER_ACTIONS.
  reopen: '↩️ вернуть тему',
  kill: '✖️ закрыть вкладку',
};

// Кнопки под шапкой темы. Отдельный список, а не «все действия»: закрытие вкладки —
// необратимо (агент завершается вместе с ходом), и такой кнопке нечего делать в панели,
// которая висит в теме всегда и по которой промахиваются пальцем.
const HEADER_ACTIONS = ['status', 'edits', 'auto', 'manual', 'new'];

function actionData(tab, action) {
  if (!QA_ACTIONS[action]) return null;
  const data = [QA_PREFIX, tab, action].join('|');
  return data.length <= CB_MAX ? data : null;
}

function parseAction(raw) {
  const parts = String(raw == null ? '' : raw).split('|');
  if (parts.length !== 3 || parts[0] !== QA_PREFIX) return null;
  if (!parts[1] || !QA_ACTIONS[parts[2]]) return null;
  return { tab: parts[1], action: parts[2] };
}

// Клавиатура быстрых действий для темы вкладки. Две в ряд: на телефоне подписи длинные.
function actionKeyboard(tab, actions) {
  const list = (Array.isArray(actions) ? actions : HEADER_ACTIONS)
    .filter((a) => QA_ACTIONS[a]);
  const rows = [];
  let row = [];
  for (const a of list) {
    const data = actionData(tab, a);
    if (!data) continue;
    row.push({ text: QA_ACTIONS[a], callback_data: data });
    if (row.length === 2) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  return rows.length ? { inline_keyboard: rows } : null;
}

function callbackData(tab, fingerprint, n) {
  const data = [CB_PREFIX, tab, fingerprint, n].join('|');
  return data.length <= CB_MAX ? data : null;
}

// --- кого адресует нажатие ----------------------------------------------------
// Номер вкладки в callback_data живёт только до перезапуска приложения: id раздаются заново с
// единицы. А сообщение с кнопками остаётся в теме навсегда — шапка темы не перерисовывается.
// Тему же держит ключ вкладки, который перезапуск переживает. Значит В ТЕМЕ адресата знает
// ТЕМА, а payload — это всего лишь то, что было верно когда-то.
//
// Без этого «⚡ вообще без вопросов» в шапке одной темы после перезапуска снимало вопросы у
// агента в ДРУГОМ репозитории, и заметить подмену было нечем.
//
// Вне тем (общая тема — запасной путь, когда тему создать не удалось) сверять не с чем, там
// остаётся payload. Что делать при расхождении, решает вызывающий: быстрой кнопке достаточно
// темы, а сообщение с запросом разрешения несёт ТЕКСТ и отпечаток конкретной вкладки, поэтому
// расхождение там значит «это сообщение не про неё» — и нажатие отклоняется.
function callbackTab(opts) {
  const o = opts || {};
  const payload = o.payloadTab == null ? null : String(o.payloadTab);
  const routed = o.routed == null ? null : String(o.routed);
  if (o.threadId == null) return { tab: payload, source: payload == null ? null : 'payload', mismatch: false };
  if (routed == null) return { tab: null, source: null, mismatch: false };
  return { tab: routed, source: 'topic', mismatch: payload != null && payload !== routed };
}

function parseCallbackData(raw) {
  const parts = String(raw == null ? '' : raw).split('|');
  if (parts.length !== 4 || parts[0] !== CB_PREFIX) return null;
  const n = Number(parts[3]);
  if (!parts[1] || !parts[2] || !Number.isInteger(n) || n < 1) return null;
  return { tab: parts[1], fingerprint: parts[2], n };
}

// Подпись кнопки. Telegram рисует inline-кнопку ОДНОЙ строкой фиксированной высоты:
// переносов в ней не бывает, растянуть её по высоте нельзя, а всё лишнее клиент обрезает
// сам — молча и ровно посередине слова. Поэтому режем мы: по границе слова и с
// многоточием, чтобы обрезка была видна. Полный текст варианта при этом уходит в само
// сообщение (см. optionsList) — там перенос свободный, и решение принимают по нему.
// Кнопки идут по одной в ряд (см. inlineKeyboard), то есть подписи достаётся вся ширина
// сообщения — отсюда и предел. Он всё равно осторожный: на узком телефоне клиент дорежет
// сам, но полный текст варианта в этот момент уже прочитан в сообщении.
const BTN_MAX = 36;

function buttonLabel(n, text, max) {
  const cap = Math.max(8, max || BTN_MAX);
  const full = `${n}. ${String(text == null ? '' : text).trim()}`;
  if (full.length <= cap) return full;
  const window = full.slice(0, cap - 1);
  const cut = window.lastIndexOf(' ');
  // Слово нашлось слишком рано — от подписи остался бы один номер; тогда лучше рубить
  // по символу, чем показывать «2. …».
  const body = cut >= cap * 0.6 ? window.slice(0, cut) : window;
  return body.replace(/[\s,;:.—-]+$/, '') + '…';
}

// Варианты Клода списком, как он их и пронумеровал. Это НЕ дубль кнопок: на кнопке
// живёт короткая метка, а здесь — то, что человек читает перед нажатием.
function optionsList(options) {
  return (Array.isArray(options) ? options : [])
    .map((o) => `${o.n}. ${String(o && o.text == null ? '' : o.text).trim()}`)
    .join('\n');
}

// `options` is what screen.js parsed: [{ n, text }]. Одна кнопка в ряд — ВСЕГДА, даже под
// «Yes» и «No». Пары экономили две строки в чате и стоили половины ширины каждой подписи, а
// подпись — единственное, что видно на кнопке: переносов в ней нет, и обрезку клиент делает
// молча. Варианты у Клода почти всегда разной длины, так что пара из короткого и длинного
// (его обычное «1. Yes / 2. Yes, and don't ask again for … / 3. No») получалась сама собой и
// била как раз по самому важному варианту.
function inlineKeyboard(options, tab, fingerprint) {
  const rows = [];
  for (const o of Array.isArray(options) ? options : []) {
    const data = callbackData(tab, fingerprint, o.n);
    if (!data) continue;                       // can't address it => don't offer it
    rows.push([{ text: buttonLabel(o.n, o.text), callback_data: data }]);
  }
  return rows.length ? { inline_keyboard: rows } : null;
}

// --- ссылка на тему ------------------------------------------------------------
// `/tabs` в общей теме — это список вкладок, и из него надо ПОПАСТЬ в нужную. Списком имён
// он отвечал только на «кто чем занят»: дальше человек закрывал чат и искал тему пальцем
// среди двух десятков. Тема адресуется ссылкой `t.me/c/<чат>/<тема>` — тап, и ты в ней.
//
// Внутренний номер супергруппы — это её id без приставки `-100`, которую Bot API добавляет
// снаружи. Не супергруппа или нет темы — ссылки нет, и вызывающий пишет просто имя: строка
// без ссылки лучше ссылки, ведущей в никуда.
function topicLink(chatId, threadId) {
  const id = String(chatId == null ? '' : chatId);
  if (!/^-100\d+$/.test(id) || !threadId) return null;
  return `https://t.me/c/${id.slice(4)}/${Number(threadId)}`;
}

// Экранирование для parse_mode: 'HTML'. Нужно ровно там, где мы сами строим разметку
// (ссылки на темы), и НИГДЕ больше: ответ агента уходит без parse_mode, потому что в коде
// полно `<`, и любая разметка превратила бы его в отказ Telegram или в кашу.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- outbound text -----------------------------------------------------------
// Telegram rejects anything over 4096 chars. Split on paragraph, then line, then hard
// — a question from an agent is prose, so breaking mid-word is the last resort.
const MAX_TEXT = 4096;

function chunkText(text, max) {
  const cap = Math.max(16, max || MAX_TEXT);
  const src = String(text == null ? '' : text);
  if (src.length <= cap) return src ? [src] : [];
  const out = [];
  let rest = src;
  while (rest.length > cap) {
    const window = rest.slice(0, cap);
    let cut = window.lastIndexOf('\n\n');
    if (cut < cap * 0.5) cut = window.lastIndexOf('\n');
    if (cut < cap * 0.5) cut = window.lastIndexOf(' ');
    if (cut < cap * 0.5) cut = cap;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

// --- retry pacing ------------------------------------------------------------
// api.telegram.org being unreachable is normal here (a VPN dropped, the laptop woke up
// in a café). Back off geometrically so a broken connection doesn't hammer the network
// or the log, and cap it so recovery is never more than a minute away.
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

function backoffMs(failures) {
  const n = Math.max(0, failures | 0);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, Math.min(n, 6)));
}

// Telegram's own «slow down» — honour it over our backoff when present.
function retryAfterMs(body) {
  const p = body && body.parameters;
  const s = p && Number(p.retry_after);
  return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, BACKOFF_MAX_MS) : 0;
}

// How a failed call should be treated. Wrong token and «someone else is polling» are
// terminal: retrying can't fix them and the user has to see them.
// Отказ ИМЕННО из-за разметки. Нужен, чтобы мост мог переслать то же сообщение без неё:
// разметка — украшение, а текст ответа агента — то, ради чего мост существует, и терять его
// из-за одного кривого тэга нельзя. Telegram формулирует это по-разному от версии к версии
// («can't parse entities: …», «Unsupported start tag», «Unmatched end tag»), поэтому смотрим
// на все известные формулировки, а не на одну.
function entityError(body) {
  const desc = (body && body.description) || '';
  return /can't parse entities|can't find end|unsupported start tag|unmatched end tag|unclosed/i.test(desc);
}

function classifyError(status, body) {
  const code = Number(status) || 0;
  const desc = (body && body.description) || '';
  if (code === 401) return { fatal: true, reason: 'unauthorized', message: 'Telegram не принял токен' };
  if (code === 404 && /not found/i.test(desc)) return { fatal: true, reason: 'unauthorized', message: 'Такого бота нет — проверь токен' };
  if (code === 409) return { fatal: true, reason: 'conflict', message: 'Этот токен уже читает кто-то другой' };
  if (code === 403) return { fatal: false, reason: 'forbidden', message: 'Бот не может писать в этот чат' };
  if (code === 429) return { fatal: false, reason: 'flood', message: 'Telegram просит подождать' };
  return { fatal: false, reason: 'network', message: desc || 'Telegram недоступен' };
}

// --- the long-poll loop ------------------------------------------------------
// `deps.fetchJson(url, body)` → { ok, status, body } and throws only on a transport
// failure; injected so tests drive the loop with no network. `sleep` is injected for
// the same reason. Everything the app does with an update happens in `onUpdate`.
const POLL_TIMEOUT_S = 25;

function createPoller(deps) {
  const d = deps || {};
  const fetchJson = d.fetchJson;
  const sleep = d.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const onUpdate = d.onUpdate || (() => {});
  const onState = d.onState || (() => {});
  const token = d.token;
  const timeoutS = d.timeoutS || POLL_TIMEOUT_S;

  let running = false;
  let stopped = false;
  let offset = d.offset || 0;
  let failures = 0;

  async function once() {
    // `my_chat_member` — единственный способ узнать, что бота выгнали или разжаловали:
    // просить его дороже не стало, а без него мост врёт про себя «в эфире».
    const res = await fetchJson(apiUrl(token, 'getUpdates'), {
      offset, timeout: timeoutS, allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    });
    if (!res || !res.ok || !res.body || res.body.ok !== true) {
      const err = classifyError(res && res.status, res && res.body);
      failures++;
      onState({ ok: false, error: err });
      if (err.fatal) { stopped = true; return; }
      await sleep(retryAfterMs(res && res.body) || backoffMs(failures));
      return;
    }
    if (failures) onState({ ok: true, error: null });   // recovered — say so once
    failures = 0;
    for (const u of res.body.result || []) {
      // Advance the offset BEFORE handling: a handler that throws must not make us
      // fetch the same update forever (Telegram would replay it on every poll).
      if (typeof u.update_id === 'number') offset = u.update_id + 1;
      try { onUpdate(readUpdate(u)); } catch (e) { onState({ ok: true, error: null, handlerError: e }); }
    }
  }

  async function run() {
    running = true;
    while (!stopped) {
      try { await once(); } catch (e) {
        failures++;
        onState({ ok: false, error: { fatal: false, reason: 'network', message: String((e && e.message) || e) } });
        await sleep(backoffMs(failures));
      }
    }
    running = false;
  }

  return {
    start() { if (!running && !stopped) return run(); return Promise.resolve(); },
    stop() { stopped = true; },
    get offset() { return offset; },
    get alive() { return running && !stopped; },
  };
}

module.exports = {
  API_HOST, MAX_TEXT, POLL_TIMEOUT_S, BACKOFF_MAX_MS, CODE_LEN, TG_TAG, tagInput,
  PROMPTS, DETAILS, detailPrompt,
  thinkingLine, fmtSpan, fmtTokens,
  apiUrl, looksLikeToken, maskToken,
  pairCode, deepLink, pairingMatch,
  readUpdate, readService, readPhoto, mediaKind, mediaLabel, MEDIA_LABELS,
  topicLink, escapeHtml, entityError,
  senderLabel, routeMessage, chunkText, inlineKeyboard, buttonLabel, optionsList, BTN_MAX, callbackData, parseCallbackData, callbackTab, CB_MAX, backoffMs, retryAfterMs, classifyError,
  inputWrites, PASTE_ON, PASTE_OFF, ENTER, BACK_TAB, ESC, routeFailure,
  COMMANDS, CLAUDE_COMMANDS, MENU_COMMANDS, isOwnCommand, claudeLine,
  QA_ACTIONS, HEADER_ACTIONS, actionData, parseAction, actionKeyboard,
  createPoller,
};
