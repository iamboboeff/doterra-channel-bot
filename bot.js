import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import { parseCSV, detectColumns, extractRecords } from './csv.js';
import { classify } from './logic.js';
import * as store from './store.js';

const MEMBER_TOKEN = process.env.MEMBER_BOT_TOKEN;
const ADMIN_TOKEN = process.env.ADMIN_BOT_TOKEN;
const CHANNEL_ID = Number(process.env.CHANNEL_ID);
const CHAT_ID = Number(process.env.CHAT_ID);
const THRESHOLD = Number(process.env.THRESHOLD) || 50;
// Куда пускаем / откуда удаляем: канал и (опционально) чат-группа.
const TARGETS = [
  { id: CHANNEL_ID, label: '📢 Канал' },
  { id: CHAT_ID, label: '💬 Чат' },
].filter((t) => Number.isFinite(t.id) && t.id !== 0);
const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean)
);

// ROLE управляет тем, какой(ие) бот(ы) активно опрашивает ЭТОТ процесс —
// удобно, когда участников- и админ-бот развёрнуты как ДВЕ отдельные записи
// на хостинге (например bothost, где 1 запись = 1 токен):
//   ROLE=member — опрашивает только бот участников
//   ROLE=admin  — опрашивает только админ-бот
//   ROLE=both   — оба в одном процессе (по умолчанию, как раньше)
// Токен «второго» бота всё равно стоит указывать в обеих записях — админ-бот
// им уведомляет участников и шлёт им ссылки-приглашения.
const ROLE = (process.env.ROLE || 'both').toLowerCase();
const wantMember = ROLE === 'member' || ROLE === 'both';
const wantAdmin = ROLE === 'admin' || ROLE === 'both';

if (!wantMember && !wantAdmin) {
  console.error(`Неверный ROLE="${ROLE}". Допустимо: member, admin, both.`);
  process.exit(1);
}
if (wantMember && !MEMBER_TOKEN) {
  console.error(`ROLE=${ROLE} требует MEMBER_BOT_TOKEN в .env`);
  process.exit(1);
}
if (wantAdmin && !ADMIN_TOKEN) {
  console.error(`ROLE=${ROLE} требует ADMIN_BOT_TOKEN в .env`);
  process.exit(1);
}
if (!TARGETS.length) {
  console.warn('⚠️  Ни CHANNEL_ID, ни CHAT_ID не заданы — бот не сможет приглашать/удалять. Впиши CHANNEL_ID в .env.');
}

// Оба объекта создаём, если токен есть, — даже если этот процесс не «опрашивает»
// соответствующего бота: его .api всё равно нужен (например, админ-процессу —
// memberBot.api, чтобы слать участникам ссылки и уведомления).
const memberBot = MEMBER_TOKEN ? new Bot(MEMBER_TOKEN) : null;
const adminBot = ADMIN_TOKEN ? new Bot(ADMIN_TOKEN) : null;

const isAdmin = (id) => ADMIN_IDS.has(id);
const fmtPv = (pv) => (pv == null ? '—' : pv);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Защита от двойного нажатия «Удалить/Обновить» — применение идёт один раз.
let applying = false;
// Состояние пошаговых действий админа (например, ввод ID для отвязки).
const adminState = new Map();

// Вызов Telegram с обработкой лимита частоты (429) и мягкими повторами.
async function tgRetry(fn, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      const ra = e?.parameters?.retry_after;
      if (ra) { await sleep((ra + 1) * 1000); continue; }         // 429 — ждём сколько велят
      if (i < tries - 1) { await sleep(400 * (i + 1)); continue; } // прочее — короткий бэкофф
      throw e;
    }
  }
}

// Приглашаем участника во все цели (канал + чат): одноразовая ссылка со сроком
// на каждую. Возвращает true, только если реально выдали хоть одну ссылку.
// Помечаем «приглашён» (не «в канале» — это подтвердит фактический вход).
async function inviteToTargets(member) {
  if (!TARGETS.length) return false;
  if (!memberBot) {
    console.error('MEMBER_BOT_TOKEN не задан в этом процессе — не могу пригласить.');
    return false;
  }
  const expire = Math.floor(Date.now() / 1000) + 24 * 3600; // ссылка живёт сутки
  const links = [];
  for (const t of TARGETS) {
    try {
      const link = await tgRetry(() =>
        memberBot.api.createChatInviteLink(t.id, { member_limit: 1, expire_date: expire, name: `reg ${member.doterraId}` })
      );
      links.push(`${t.label}: ${link.invite_link}`);
    } catch (e) {
      console.error('Не удалось создать ссылку для', t.label, e.message);
    }
  }
  if (!links.length) return false;
  await tgRetry(() =>
    memberBot.api.sendMessage(member.userId, `✅ Доступ открыт! Заходи по ссылкам (одноразовые, действуют сутки):\n\n${links.join('\n')}`)
  );
  store.setInvited(member.doterraId, true);
  return true;
}

// Приглашаем всех, кто набрал баллы, но ещё не внутри и ещё не приглашён.
async function reinviteQualified(pointsMap) {
  let invited = 0;
  for (const m of store.listMembers()) {
    if (m.inChannel || m.invited) continue; // уже внутри или уже с активной ссылкой
    const pv = pointsMap.get(m.doterraId);
    if (pv != null && pv >= THRESHOLD) {
      try {
        if (await inviteToTargets(m)) { invited++; await sleep(300); }
      } catch (e) {
        console.error('Не удалось пригласить', m.doterraId, e.message);
      }
    }
  }
  return invited;
}

// Кик из всех целей: бан выкидывает, разбан ТУТ ЖЕ (с повторами) снимает из ЧС.
async function banEverywhere(userId) {
  if (!adminBot) {
    console.error('ADMIN_BOT_TOKEN не задан в этом процессе — не могу забанить.');
    return { banned: false, unbanFail: false };
  }
  let banned = false, unbanFail = false;
  for (const t of TARGETS) {
    try {
      await tgRetry(() => adminBot.api.banChatMember(t.id, userId));
      banned = true;
    } catch (e) {
      console.error('Не удалось забанить в', t.label, userId, e.message);
    }
    // Разбан ОБЯЗАТЕЛЬНО и с повторами — иначе человек застрянет в чёрном списке.
    try {
      await tgRetry(() => adminBot.api.unbanChatMember(t.id, userId, { only_if_banned: true }));
    } catch (e) {
      console.error('Не удалось разбанить в', t.label, userId, e.message);
      unbanFail = true;
    }
  }
  return { banned, unbanFail };
}

// Оцениваем участника по последнему снимку баллов и реагируем.
async function evaluateAndReply(ctx, member) {
  const pv = store.getPoints(member.doterraId);
  if (pv == null) {
    await ctx.reply(
      `ID *${member.doterraId}* принят ✅\nБаллы появятся после ближайшего обновления базы — я напишу, как откроется доступ.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  if (pv < THRESHOLD) {
    await ctx.reply(
      `Принято. Сейчас у тебя *${pv}* балл(ов), нужно *${THRESHOLD}*.\nНабери баллы и нажми /check.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  if (member.inChannel) {
    await ctx.reply(`Ты уже в канале ✅ (баллы: ${pv}).`);
    return;
  }
  const ok = await inviteToTargets(member);
  if (!ok) {
    await ctx.reply(
      `У тебя *${pv}* балл(ов) — доступ положен ✅, но выдать ссылку сейчас не вышло. ` +
        `Нажми /check ещё раз чуть позже или напиши администратору.`,
      { parse_mode: 'Markdown' }
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  БОТ УЧАСТНИКОВ
// ─────────────────────────────────────────────────────────────────────────
if (memberBot) {
memberBot.command('start', async (ctx) => {
  const existing = store.findMemberByUser(ctx.from.id);
  if (existing) {
    const pv = store.getPoints(existing.doterraId);
    await ctx.reply(
      `Ты уже зарегистрирован.\nID: ${existing.doterraId}\nБаллы: ${fmtPv(pv)}\n\n` +
        `Нажми /check, чтобы проверить доступ заново, или пришли другой ID, если ошибся.`
    );
    return;
  }
  store.setFlow(ctx.from.id, 'awaiting_id');
  await ctx.reply(
    `Привет! 👋\nЧтобы попасть в канал, пришли свой *ID участника doTERRA* — это номер из кабинета (обычно 7–8 цифр).\nНапример: 18170008`,
    { parse_mode: 'Markdown' }
  );
});

memberBot.command('check', async (ctx) => {
  const member = store.findMemberByUser(ctx.from.id);
  if (!member) {
    store.setFlow(ctx.from.id, 'awaiting_id');
    await ctx.reply('Ты ещё не зарегистрирован. Пришли свой ID doTERRA (7–8 цифр).');
    return;
  }
  await evaluateAndReply(ctx, member);
});

memberBot.command('whoami', (ctx) => ctx.reply(`Твой user_id: ${ctx.from.id}`));

memberBot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();

  // Любой корректный ID (6–9 цифр) = регистрация ИЛИ исправление прежней.
  if (/^\d{6,9}$/.test(text)) {
    // Защита от дублей: один doTERRA ID = один Telegram-аккаунт.
    // Если ID уже привязан к ДРУГОМУ аккаунту — отказ (чужой ID не угонишь).
    const owner = store.getMember(text);
    if (owner && owner.userId !== ctx.from.id) {
      await ctx.reply(
        `⛔️ ID *${text}* уже привязан к другому Telegram-аккаунту.\n` +
          `Если это ваш ID и вышла ошибка — напишите администратору, он переназначит.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    const member = store.registerMember(text, ctx.from);
    await evaluateAndReply(ctx, member);
    return;
  }

  const flow = store.getFlow(ctx.from.id);
  if (flow?.step === 'awaiting_id') {
    await ctx.reply('Пришли только цифры ID (обычно 7–8 цифр), например 18170008.');
    return;
  }
  const member = store.findMemberByUser(ctx.from.id);
  await ctx.reply(
    member
      ? 'Пришли ID (7–8 цифр), если хочешь исправить, или нажми /check для проверки доступа.'
      : 'Напиши /start, чтобы зарегистрироваться.'
  );
});

// Реальное вступление/выход в канале/чате → это и есть источник правды inChannel.
memberBot.on('chat_member', (ctx) => {
  const upd = ctx.chatMember;
  if (!TARGETS.some((t) => t.id === ctx.chat?.id)) return;
  const uid = upd.new_chat_member?.user?.id;
  const status = upd.new_chat_member?.status;
  const member = uid && store.findMemberByUser(uid);
  if (!member) return;
  const inside = status === 'member' || status === 'administrator' || status === 'creator';
  store.setInChannel(member.doterraId, inside);
});
} // if (memberBot)

// ─────────────────────────────────────────────────────────────────────────
//  АДМИН-БОТ
// ─────────────────────────────────────────────────────────────────────────
function mainMenu() {
  return new InlineKeyboard()
    .text('📥 Обновить подписчиков', 'adm_update').row()
    .text('📋 Список участников', 'adm_list').row()
    .text('🔗 Отвязать участника', 'adm_unbind_start').row()
    .text('ℹ️ Статус', 'adm_status');
}

if (adminBot) {
adminBot.use(async (ctx, next) => {
  const uid = ctx.from?.id;
  if (uid && !isAdmin(uid)) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery('Только для администратора.');
    else await ctx.reply(`Этот бот только для администратора. Твой user_id: ${uid}`);
    return;
  }
  await next();
});

adminBot.command('whoami', (ctx) => ctx.reply(`Твой user_id: ${ctx.from.id}`));
adminBot.command('chanhelp', (ctx) =>
  ctx.reply(
    'Чтобы узнать ID канала: добавь этого бота админом в канал, перешли сюда любой пост из канала боту @getidsbot — ' +
      'он покажет ID вида -100…, впиши его в .env как CHANNEL_ID.'
  )
);
adminBot.command('start', (ctx) =>
  ctx.reply('Админ-панель канала doTERRA. Выбери действие ниже.\nЕщё есть команды — /help.', { reply_markup: mainMenu() })
);

adminBot.command('help', (ctx) =>
  ctx.reply(
    'Команды админа:\n' +
      '• /rebind <ID> <user_id> — перепривязать doTERRA ID на другой Telegram-аккаунт\n' +
      '• /unbind <ID> — снять привязку ID (освободить)\n' +
      '• /whoami — показать твой user_id\n\n' +
      'Обновление подписчиков и списки — через меню /start.\n' +
      'user_id нужного аккаунта: пусть человек напишет боту-участников /whoami.'
  )
);

// Перепривязать ID на другой Telegram-аккаунт (со снятием старого доступа).
adminBot.command('rebind', async (ctx) => {
  const parts = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const [doterraId, newUid] = parts;
  if (!/^\d{6,9}$/.test(doterraId || '') || !/^\d{5,}$/.test(newUid || '')) {
    return ctx.reply(
      'Перепривязать ID на другой аккаунт:\n/rebind <doTERRA ID> <новый user_id>\n\n' +
        'Например: /rebind 18170008 123456789\n' +
        'Новый user_id: пусть человек напишет боту-участников /whoami и пришлёт число.'
    );
  }
  const member = store.getMember(doterraId);
  if (!member) {
    return ctx.reply(`ID ${doterraId} ещё никем не занят — привязывать нечего. Пусть человек просто зарегистрируется у бота-участников.`);
  }
  const newUidNum = Number(newUid);
  const conflict = store.findMemberByUser(newUidNum);
  if (conflict && conflict.doterraId !== doterraId) {
    return ctx.reply(`У аккаунта ${newUid} уже привязан ID ${conflict.doterraId}. Сначала: /unbind ${conflict.doterraId}`);
  }
  const oldUid = member.userId;
  if (oldUid && oldUid !== newUidNum) {
    try { await banEverywhere(oldUid); } catch (e) { console.error('rebind old kick', e.message); }
  }
  store.rebindMember(doterraId, newUidNum);
  await ctx.reply(`✅ ID ${doterraId} перепривязан на аккаунт ${newUid}. Прежний доступ отозван.`);

  const pv = store.getPoints(doterraId);
  if (pv != null && pv >= THRESHOLD) {
    try {
      const ok = await inviteToTargets(store.getMember(doterraId));
      await ctx.reply(ok ? 'Новому аккаунту отправлены ссылки в канал/чат.' : 'Ссылку отправить не вышло — пусть новый аккаунт напишет боту-участников /check.');
    } catch {
      await ctx.reply('Ссылку отправить не вышло — пусть новый аккаунт напишет боту-участников /check.');
    }
  } else {
    await ctx.reply(`Пока баллов < ${THRESHOLD} — доступ откроется, как только наберёт.`);
  }
});

// Снять привязку ID (освободить) + отозвать старый доступ.
adminBot.command('unbind', async (ctx) => {
  const id = (ctx.match || '').trim();
  if (!/^\d{6,9}$/.test(id)) return ctx.reply('Освободить ID:\n/unbind <doTERRA ID>\nНапример: /unbind 18170008');
  const member = store.getMember(id);
  if (!member) return ctx.reply(`ID ${id} не привязан.`);
  if (member.userId) {
    try { await banEverywhere(member.userId); } catch (e) { console.error('unbind kick', e.message); }
  }
  store.unbindMember(id);
  await ctx.reply(`✅ ID ${id} освобождён, старый доступ отозван. Теперь на него может зарегистрироваться другой человек.`);
});

adminBot.callbackQuery('adm_update', async (ctx) => {
  store.startImport(ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.reply(
    '📥 Пришли CSV-файл, снятый расширением «👥 doTERRA → бот».\n' +
      'Если кабинета два — пришли оба файла по очереди, потом жми «Посчитать».',
    { reply_markup: new InlineKeyboard().text('✅ Посчитать на вылет', 'adm_calc').text('❌ Отмена', 'adm_cancel') }
  );
});

adminBot.callbackQuery('adm_list', async (ctx) => {
  const members = store.listMembers();
  await ctx.answerCallbackQuery();
  if (!members.length) return ctx.reply('Пока никто не зарегистрирован.');
  const lines = members.map((m) => {
    const pv = store.getPoints(m.doterraId);
    const mark = m.inChannel ? '🟢' : m.invited ? '🟡' : '⚪️';
    return `${mark} ${m.name || '—'} · ${m.doterraId} · ${fmtPv(pv)}`;
  });
  // Telegram-сообщение ограничено ~4096 символами — режем длинный список.
  const head = `Участники (${members.length}) — 🟢 в канале, 🟡 приглашён, ⚪️ ждёт баллов:\n`;
  let body = lines.join('\n');
  if ((head + body).length > 3800) body = lines.slice(0, 60).join('\n') + `\n… и ещё ${members.length - 60}`;
  await ctx.reply(head + body);
});

adminBot.callbackQuery('adm_status', async (ctx) => {
  const members = store.listMembers();
  const inCh = members.filter((m) => m.inChannel).length;
  const inv = members.filter((m) => m.invited && !m.inChannel).length;
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `Зарегистрировано: ${members.length}\nВ канале: ${inCh}\nПриглашены (ждут входа): ${inv}\n` +
      `Порог: ${THRESHOLD}\nСнимок баллов: ${Object.keys(store.getData().points).length} записей.\n` +
      `Каналов/чатов под управлением: ${TARGETS.length}`
  );
});

adminBot.callbackQuery('adm_cancel', async (ctx) => {
  store.clearImport();
  await ctx.answerCallbackQuery('Отменено');
  await ctx.reply('Импорт отменён.', { reply_markup: mainMenu() });
});

// ── Просмотр и отвязка привязки участника (кнопкой) ──
adminBot.callbackQuery('adm_unbind_start', async (ctx) => {
  adminState.set(ctx.from.id, { step: 'await_unbind_id' });
  await ctx.answerCallbackQuery();
  await ctx.reply('Введите ID doTERRA участника (номер из кабинета):', {
    reply_markup: new InlineKeyboard().text('◀️ Назад', 'adm_back'),
  });
});

adminBot.callbackQuery('adm_back', async (ctx) => {
  adminState.delete(ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.reply('Меню:', { reply_markup: mainMenu() });
});

adminBot.callbackQuery(/^adm_unbind:(\d{6,9})$/, async (ctx) => {
  const id = ctx.match[1];
  await ctx.answerCallbackQuery();
  const m = store.getMember(id);
  if (!m) return ctx.reply('Уже отвязан или не найден.', { reply_markup: mainMenu() });
  if (m.userId) {
    try { await banEverywhere(m.userId); } catch (e) { console.error('unbind kick', e.message); }
  }
  store.unbindMember(id);
  await ctx.reply(
    `✅ Аккаунт отвязан от ID ${id}, доступ отозван.\nТеперь на этот ID может зарегистрироваться другой человек.`,
    { reply_markup: mainMenu() }
  );
});

// Ввод ID doTERRA для просмотра/отвязки (когда админ в этом шаге).
adminBot.on('message:text', async (ctx) => {
  const st = adminState.get(ctx.from.id);
  if (st?.step !== 'await_unbind_id') return;
  const id = ctx.message.text.trim();
  if (!/^\d{6,9}$/.test(id)) {
    await ctx.reply('Нужен номер ID (6–9 цифр). Или нажмите «Назад».', {
      reply_markup: new InlineKeyboard().text('◀️ Назад', 'adm_back'),
    });
    return;
  }
  adminState.delete(ctx.from.id);
  const m = store.getMember(id);
  if (!m) {
    await ctx.reply(`ID ${id} ни к кому не привязан.`, { reply_markup: mainMenu() });
    return;
  }
  const tg = m.username ? '@' + m.username : '(без username)';
  const status = m.inChannel ? '🟢 в канале' : m.invited ? '🟡 приглашён' : '⚪️ ждёт баллов';
  const pv = store.getPoints(id);
  await ctx.reply(
    `🔗 Привязка ID ${id}\n` +
      `Имя: ${m.name || '—'}\n` +
      `Telegram: ${tg}\n` +
      `user_id: ${m.userId}\n` +
      `Баллы: ${pv == null ? '—' : pv}\n` +
      `Статус: ${status}`,
    {
      reply_markup: new InlineKeyboard()
        .text('◀️ Назад', 'adm_back')
        .text('🔓 Отвязать аккаунт от ID', `adm_unbind:${id}`),
    }
  );
});

// Приём CSV-файла от админа
adminBot.on('message:document', async (ctx) => {
  const session = store.getImport();
  if (!session) {
    await ctx.reply('Сначала нажми «📥 Обновить подписчиков».', { reply_markup: mainMenu() });
    return;
  }
  try {
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${ADMIN_TOKEN}/${file.file_path}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('не удалось скачать файл (HTTP ' + resp.status + ')');
    if (Number(resp.headers.get('content-length') || 0) > 5_000_000) throw new Error('файл слишком большой');
    const text = await resp.text();
    const rows = parseCSV(text);
    const det = detectColumns(rows);
    if (det.idIdx < 0 || det.pointsIdx < 0) {
      await ctx.reply('Не нашёл колонки ID и PV. Это точно файл от расширения «doTERRA → бот»?');
      return;
    }
    const records = extractRecords(rows, det.idIdx, det.pointsIdx);
    const added = store.addImportFile(ctx.message.document.file_name || 'csv', records);

    const sess = store.getImport();
    const inChannel = store.listMembers().filter((m) => m.inChannel);
    const missing = inChannel.filter((m) => !(m.doterraId in sess.points));
    const warn =
      missing.length > 0
        ? `\n⚠️ ${missing.length} из ${inChannel.length} в канале нет в файле — возможно, второй кабинет. ` +
          `Пришли второй файл или жми «Посчитать» (их не тронем).`
        : '';

    await ctx.reply(`Файл принят: ${added} строк (всего файлов: ${sess.files.length}).${warn}`, {
      reply_markup: new InlineKeyboard().text('✅ Посчитать на вылет', 'adm_calc').text('❌ Отмена', 'adm_cancel'),
    });
  } catch (e) {
    await ctx.reply('Ошибка чтения файла: ' + e.message);
  }
});

// «Посчитать» — показываем список И ЗАМОРАЖИВАЕМ его: подтверждение применит
// именно этот список, ничего нового в момент бана не добавится.
adminBot.callbackQuery('adm_calc', async (ctx) => {
  const session = store.getImport();
  await ctx.answerCallbackQuery();
  if (!session || !session.files.length) return ctx.reply('Сначала пришли хотя бы один CSV-файл.');

  const pointsMap = new Map(Object.entries(session.points));
  const inChannel = store.listMembers().filter((m) => m.inChannel);
  const { toRemove, missing } = classify(inChannel, pointsMap, THRESHOLD);
  store.setReviewed(toRemove.map((m) => ({ doterraId: m.doterraId, userId: m.userId, pv: m.pv })));

  if (!toRemove.length) {
    await ctx.reply(
      `Никого удалять не нужно — все в канале набрали ${THRESHOLD}+.` +
        (missing.length ? `\n(${missing.length} без данных — не тронуты.)` : ''),
      { reply_markup: new InlineKeyboard().text('✅ Обновить баллы (без удаления)', 'adm_commit').text('❌ Отмена', 'adm_cancel') }
    );
    return;
  }

  const list = toRemove.map((m, i) => `${i + 1}. ${m.name || '—'} · ${m.doterraId} · ${m.pv} балл.`).join('\n');
  const text =
    `❌ НА ВЫЛЕТ (PV < ${THRESHOLD}) — ${toRemove.length}:\n${list}` +
    (missing.length ? `\n\n⚠️ Без данных (не тронем): ${missing.length}` : '') +
    `\n\nПодтвердить удаление?`;
  const trimmed = text.length > 3800 ? text.slice(0, 3800) + '\n… (список длинный)' : text;
  await ctx.reply(trimmed, {
    reply_markup: new InlineKeyboard().text(`🗑 Удалить ${toRemove.length}`, 'adm_confirm').text('❌ Отмена', 'adm_cancel'),
  });
});

// Обновить баллы БЕЗ удаления (ветка «никого удалять не нужно»).
adminBot.callbackQuery('adm_commit', async (ctx) => {
  const session = store.getImport();
  if (!session || !session.files.length) {
    await ctx.answerCallbackQuery('Нет загруженных файлов.');
    return ctx.reply('Нет активного импорта.', { reply_markup: mainMenu() });
  }
  if (applying) { await ctx.answerCallbackQuery('Уже выполняется…'); return; }
  applying = true;
  await ctx.answerCallbackQuery();
  try {
    const pointsMap = new Map(Object.entries(session.points));
    if (pointsMap.size) store.commitPoints(pointsMap);
    const invited = await reinviteQualified(pointsMap);
    store.clearImport();
    await ctx.reply(`Баллы обновлены, никого не удалял.\n✅ Приглашено (набрали баллы): ${invited}`, { reply_markup: mainMenu() });
  } catch (e) {
    console.error('adm_commit:', e.message);
    await ctx.reply('Ошибка: ' + e.message, { reply_markup: mainMenu() });
  } finally {
    applying = false;
  }
});

// Подтверждение удаления — применяем ТОЛЬКО замороженный список из adm_calc.
adminBot.callbackQuery('adm_confirm', async (ctx) => {
  const session = store.getImport();
  if (!session || !session.files.length || !session.reviewed) {
    await ctx.answerCallbackQuery('Сначала нажми «Посчитать».');
    return ctx.reply('Сначала «✅ Посчитать на вылет», потом подтверждай.', { reply_markup: mainMenu() });
  }
  if (applying) { await ctx.answerCallbackQuery('Уже выполняется, подожди…'); return; }
  applying = true;
  await ctx.answerCallbackQuery();
  await ctx.reply(`⏳ Применяю: до ${session.reviewed.length} на удаление. Это может занять минуту…`);

  try {
    const pointsMap = new Map(Object.entries(session.points));
    if (pointsMap.size) store.commitPoints(pointsMap);

    let removed = 0, skipped = 0, stuck = 0;
    for (const r of session.reviewed) {
      const m = store.getMember(r.doterraId);
      const pv = pointsMap.has(r.doterraId) ? pointsMap.get(r.doterraId) : null;
      // повторная валидация: всё ещё в канале и всё ещё ниже порога
      if (!m || !m.inChannel || pv == null || !(pv < THRESHOLD)) { skipped++; continue; }
      const { banned, unbanFail } = await banEverywhere(m.userId);
      if (banned) {
        store.setInChannel(m.doterraId, false);
        store.setInvited(m.doterraId, false);
        removed++;
        if (unbanFail) stuck++;
        if (memberBot) {
          try {
            await memberBot.api.sendMessage(
              m.userId,
              `Доступ закрыт: ${pv} балл(ов), нужно ${THRESHOLD}. Набери баллы и нажми /check — снова откроем доступ.`
            );
          } catch {}
        }
      }
      await sleep(350); // троттлинг против лимитов Telegram
    }

    const invited = await reinviteQualified(pointsMap);
    store.clearImport();

    let msg = `Готово.\n🗑 Удалено: ${removed}\n✅ Приглашено (набрали баллы): ${invited}`;
    if (skipped) msg += `\nℹ️ Пропущено (уже вышли/восстановились): ${skipped}`;
    if (stuck) msg += `\n⚠️ У ${stuck} не удалось снять бан — проверь права бота и повтори.`;
    await ctx.reply(msg, { reply_markup: mainMenu() });
  } catch (e) {
    console.error('adm_confirm:', e.message);
    await ctx.reply('Ошибка при применении: ' + e.message, { reply_markup: mainMenu() });
  } finally {
    applying = false;
  }
});
} // if (adminBot)

// ─────────────────────────────────────────────────────────────────────────
if (memberBot) memberBot.catch((err) => console.error('memberBot:', err.error?.message || err.message));
if (adminBot) adminBot.catch((err) => console.error('adminBot:', err.error?.message || err.message));

if (memberBot && wantMember) {
  memberBot.start({
    allowed_updates: ['message', 'callback_query', 'chat_member'],
    onStart: () => console.log('✓ Бот участников запущен'),
  });
}
if (adminBot && wantAdmin) {
  adminBot.start({
    allowed_updates: ['message', 'callback_query'],
    onStart: () => console.log('✓ Админ-бот запущен'),
  });
}
