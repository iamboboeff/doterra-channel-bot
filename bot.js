import 'dotenv/config';
import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { parseCSV, detectColumns, extractRecords } from './csv.js';
import { classify } from './logic.js';
import { parseAdminTarget } from './admin-access.js';
import * as store from './store.js';
import { startIngestServer } from './ingest.js';

// ─────────────────────────────────────────────────────────────────────────
//  ОДИН БОТ НА ВСЁ
//  Один Telegram-бот обслуживает и участников (регистрация по doTERRA ID,
//  выдача ссылок в чаты), и администраторов (импорт CSV, чистка по баллам).
//  Кто перед ботом — решает isAdmin(): админ видит панель, остальные — регистрацию.
//  Этот же бот должен быть админом в чатах-тирах с правами «Пригласительные
//  ссылки» и «Блокировка пользователей».
// ─────────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.MEMBER_BOT_TOKEN || process.env.ADMIN_BOT_TOKEN;
if (!BOT_TOKEN) { console.error('Нужен BOT_TOKEN в .env'); process.exit(1); }

// ── Чаты-тиры: TIER1_ID / TIER1_THRESHOLD / TIER1_NAME, TIER2_… и т.д. ──────
// Тир = один чат со своим порогом баллов. id можно оставить пустым, пока чат не
// создан (тогда бот не приглашает/не банит в него, но кнопки/расчёт работают).
function loadTiers() {
  const tiers = [];
  for (let n = 1; n <= 9; n++) {
    const name = process.env[`TIER${n}_NAME`];
    const idNum = Number(process.env[`TIER${n}_ID`]);
    const hasId = Number.isFinite(idNum) && idNum !== 0;
    if (!name && !hasId) continue;
    tiers.push({
      key: String(n),
      id: hasId ? idNum : null,
      threshold: Number(process.env[`TIER${n}_THRESHOLD`]) || 50,
      name: name || `Чат №${n}`,
    });
  }
  return tiers;
}
const TIERS = loadTiers();
const tierByKey = (k) => TIERS.find((t) => t.key === k);
const tierByChat = (chatId) => TIERS.find((t) => t.id === chatId);

const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean)
);
const ADMIN_USERNAMES = new Set(
  (process.env.ADMIN_USERNAMES || '').split(',').map((s) => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean)
);
// Фолбэк-админы на ПЕРВИЧНУЮ настройку: первые N человек, написавших /admin,
// становятся администраторами. Работает ТОЛЬКО пока не задан ни один
// ADMIN_IDS/ADMIN_USERNAMES — иначе (как сейчас) выключен, чтобы обычный
// участник не мог случайно получить админку. 0 — выключить полностью.
const MAX_AUTO_ADMINS = Number.isFinite(Number(process.env.MAX_AUTO_ADMINS)) ? Number(process.env.MAX_AUTO_ADMINS) : 5;
const HAS_EXPLICIT_ADMINS = ADMIN_IDS.size > 0 || ADMIN_USERNAMES.size > 0;

if (!TIERS.length) console.warn('⚠️  Не настроено ни одного чата (TIER1_NAME…). Бот не сможет приглашать/удалять.');

const bot = new Bot(BOT_TOKEN);

const isAdmin = (u) =>
  !!u && (ADMIN_IDS.has(u.id) || (u.username && ADMIN_USERNAMES.has(u.username.toLowerCase())) || store.isStoredAdmin(u));
const fmtPv = (pv) => (pv == null ? '—' : pv);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Помощники вывода ────────────────────────────────────────────────────────
const escHtml = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
// Кликабельное имя, открывающее профиль в Telegram (работает и без @username).
const mention = (userId, name) => `<a href="tg://user?id=${userId}">${escHtml(name || '—')}</a>`;
// Строка человека без HTML (для запасного текстового варианта).
const plainName = (m) => `${m.name || '—'}${m.username ? ' @' + m.username : ''}`;
// Список с ограничением по количеству, чтобы не порвать HTML при обрезке.
const renderPeople = (arr, fmt, cap = 30) =>
  arr.slice(0, cap).map(fmt).join('\n') + (arr.length > cap ? `\n… и ещё ${arr.length - cap}` : '');

let applying = false;
const adminState = new Map();

async function tgRetry(fn, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      const ra = e?.parameters?.retry_after;
      if (ra) { await sleep((ra + 1) * 1000); continue; }
      if (i < tries - 1) { await sleep(400 * (i + 1)); continue; }
      throw e;
    }
  }
}

// Одноразовая ссылка (на сутки) в чат тира. Возвращает строку ссылки или null.
async function inviteLink(member, tier) {
  if (!tier.id) return null;
  const expire = Math.floor(Date.now() / 1000) + 24 * 3600;
  try {
    const link = await tgRetry(() =>
      bot.api.createChatInviteLink(tier.id, { member_limit: 1, expire_date: expire, name: `reg ${member.doterraId} t${tier.key}` })
    );
    return link.invite_link;
  } catch (e) { console.error('Ссылка для', tier.name, e.message); return null; }
}

// Кик из конкретного чата: бан + сразу разбан (чтобы не копился ЧС).
async function banFromTier(userId, tier) {
  if (!tier.id) return { banned: false };
  let banned = false;
  try { await tgRetry(() => bot.api.banChatMember(tier.id, userId)); banned = true; }
  catch (e) { console.error('Бан', tier.name, userId, e.message); }
  try { await tgRetry(() => bot.api.unbanChatMember(tier.id, userId, { only_if_banned: true })); }
  catch (e) { console.error('Разбан', tier.name, userId, e.message); }
  return { banned };
}

async function kickFromAllTiers(member) {
  for (const t of TIERS) {
    if (member.tiers?.[t.key] && t.id) await banFromTier(member.userId, t);
  }
}

// Реальный статус участника в чате тира (getChatMember). Возвращает объект
// статуса или null, если проверить нельзя (нет id/юзера или Telegram-ошибка).
async function chatMemberStatus(tier, userId) {
  if (!tier.id || !userId) return null;
  try { return await tgRetry(() => bot.api.getChatMember(tier.id, userId)); }
  catch { return null; }
}
const isInsideStatus = (cm) =>
  !!cm && (cm.status === 'member' || cm.status === 'administrator' || cm.status === 'creator' || (cm.status === 'restricted' && cm.is_member));

// Сверяет по getChatMember, кто из ЗАРЕГИСТРИРОВАННЫХ реально сейчас в чате тира,
// и обновляет их состояние: вошёл → 'in', вышел → снимаем. «Приглашённых» (ещё
// не вошедших) не трогаем. Незарегистрированных бот не видит в принципе.
// Возвращает { checked, inside }.
async function syncTierMembership(tier) {
  let checked = 0, inside = 0;
  if (!tier.id) return { checked, inside };
  for (const m of store.listMembers()) {
    if (!m.userId) continue;
    const cm = await chatMemberStatus(tier, m.userId);
    await sleep(40);
    if (!cm) continue; // не смогли проверить — состояние не меняем
    checked++;
    if (isInsideStatus(cm)) { store.setTierState(m.doterraId, tier.key, 'in'); inside++; }
    else if (m.tiers?.[tier.key] === 'in') store.setTierState(m.doterraId, tier.key, null); // вышел
  }
  return { checked, inside };
}

// По текущим баллам приглашаем участника во все чаты, где он проходит порог и
// ещё не состоит. Возвращает { links, inNow, lack, soon }.
async function admit(member) {
  const pv = store.getPoints(member.doterraId);
  const res = { pv, links: [], inNow: [], lack: [], soon: [] };
  if (pv == null) return res;
  for (const t of TIERS) {
    const fresh = store.getMember(member.doterraId) || member;
    const state = fresh.tiers?.[t.key];
    if (pv >= t.threshold) {
      if (state === 'in') { res.inNow.push(t.name); continue; }
      // Уже в чате (например, вступил до бота)? Пометим 'in' и не шлём лишнюю ссылку.
      if (t.id && isInsideStatus(await chatMemberStatus(t, fresh.userId))) {
        store.setTierState(fresh.doterraId, t.key, 'in'); res.inNow.push(t.name); continue;
      }
      const link = await inviteLink(fresh, t);
      if (link) { res.links.push(`${t.name}: ${link}`); store.setTierState(fresh.doterraId, t.key, 'invited'); }
      else res.soon.push(t.name); // чат ещё не подключён
    } else {
      res.lack.push(`${t.name} — нужно ${t.threshold}`);
    }
  }
  return res;
}

async function evaluateAndReply(ctx, member) {
  const r = await admit(member);
  if (r.pv == null) {
    await ctx.reply(
      `✅ Готово — ID ${member.doterraId} принят!\n\nБаллы подтянутся при ближайшем обновлении базы. Как только доступ откроется, я сразу напишу.`
    );
    return;
  }
  let msg = '';
  if (r.links.length) msg += `🎉 Доступ открыт! Заходи по ссылкам ниже (одноразовые, действуют сутки):\n\n${r.links.join('\n')}\n\n`;
  if (r.inNow.length) msg += `✅ Ты уже в: ${r.inNow.join(', ')}.\n`;
  if (r.soon.length) msg += `⏳ Доступ положен, но ${r.soon.join(', ')} ещё настраивается — загляни позже через /check.\n`;
  if (r.lack.length) msg += `📊 Пока не хватает баллов (у тебя ${r.pv}):\n• ${r.lack.join('\n• ')}\n`;
  await ctx.reply((msg || `Твои баллы: ${r.pv}. Доступных чатов пока нет.`).trim());
}

// ─────────────────────────────────────────────────────────────────────────
//  ОБЩИЕ КОМАНДЫ (роль определяется по isAdmin)
// ─────────────────────────────────────────────────────────────────────────
function mainMenu() {
  return new InlineKeyboard()
    .text('📲 Данные из расширения', 'adm_inbox').row()
    .text('📥 Обновить файлом (CSV)', 'adm_update').row()
    .text('📋 Список участников', 'adm_list').row()
    .text('👀 Кто не зарегистрирован', 'adm_unreg').row()
    .text('🔗 Отвязать участника', 'adm_unbind_start').row()
    .text('👑 Администраторы', 'adm_admins').row()
    .text('ℹ️ Статус', 'adm_status');
}

// Кнопки под результатом «Посчитать»: удалить / пригласить / и то и то —
// показываем только применимые (по числу на вылет и на приглашение).
function applyKeyboard(nRemove, nInvite) {
  const kb = new InlineKeyboard();
  if (nRemove && nInvite) {
    return kb
      .text(`🗑 Только удалить (${nRemove})`, 'adm_del').row()
      .text(`➕ Только пригласить (${nInvite})`, 'adm_inv').row()
      .text('🗑➕ Удалить и пригласить', 'adm_both').row()
      .text('❌ Отмена', 'adm_cancel');
  }
  if (nRemove) return kb.text(`🗑 Удалить (${nRemove})`, 'adm_del').row().text('❌ Отмена', 'adm_cancel');
  if (nInvite) return kb.text(`➕ Пригласить (${nInvite})`, 'adm_inv').row().text('❌ Отмена', 'adm_cancel');
  return kb.text('✅ Обновить баллы', 'adm_inv').row().text('❌ Отмена', 'adm_cancel');
}
const showAdminPanel = (ctx) =>
  ctx.reply('🛠 Админ-панель doTERRA\n\nВыбери действие кнопкой ниже. Другие команды — /help.', { reply_markup: mainMenu() });

const phoneConfirmKeyboard = () =>
  new Keyboard().requestContact('📱 Отправить мой номер').resized().oneTime();

function adminListText() {
  const dynamic = store.getAdminAccess();
  const envIds = [...ADMIN_IDS].map(String);
  const envNames = [...ADMIN_USERNAMES].map((name) => '@' + name);
  const dynamicNames = dynamic.usernames.map((name) => '@' + name);
  const pendingPhones = dynamic.phones.map((phone) => '+' + phone);
  const lines = [
    '👑 Администраторы',
    '',
    `По ID из настроек: ${envIds.length ? envIds.join(', ') : '—'}`,
    `По username из настроек: ${envNames.length ? envNames.join(', ') : '—'}`,
    `Добавлены по ID: ${dynamic.ids.length ? dynamic.ids.join(', ') : '—'}`,
    `Добавлены по username: ${dynamicNames.length ? dynamicNames.join(', ') : '—'}`,
    `Ожидают подтверждение телефона: ${pendingPhones.length ? pendingPhones.join(', ') : '—'}`,
    '',
    'Добавить: /addadmin <ID | @username | +телефон>',
  ];
  return lines.join('\n');
}

// Пассивное отслеживание членства: если ЗАРЕГИСТРИРОВАННЫЙ участник пишет в
// чате-тире — значит он реально там; помечаем 'in'. Сообщение не перехватываем.
bot.on('message', async (ctx, next) => {
  const t = tierByChat(ctx.chat?.id);
  if (t && ctx.from && !ctx.from.is_bot) {
    store.recordSeen(ctx.from, t.key); // запоминаем, кого видели в чате (для поиска незарег.)
    const m = store.findMemberByUser(ctx.from.id);
    if (m && m.tiers?.[t.key] !== 'in') store.setTierState(m.doterraId, t.key, 'in');
  }
  await next();
});

// /start — админ сразу попадает в панель, остальные регистрируются.
bot.command('start', async (ctx) => {
  if (isAdmin(ctx.from)) return showAdminPanel(ctx);
  const existing = store.findMemberByUser(ctx.from.id);
  if (existing) {
    const pv = store.getPoints(existing.doterraId);
    await ctx.reply(`✅ Ты уже зарегистрирован.\n\n🆔 doTERRA ID: ${existing.doterraId}\n⭐️ Баллы: ${fmtPv(pv)}\n\nНажми /check — проверю доступ в чаты. Ошибся с ID? Просто пришли правильный.`);
    return;
  }
  store.setFlow(ctx.from.id, 'awaiting_id');
  await ctx.reply(`👋 Привет! Это бот доступа в чаты «Бережное врачевание».\n\nЧтобы войти, пришли свой ID участника doTERRA — номер из личного кабинета (обычно 7–8 цифр).\n\nНапример: 18170008`);
});

// /admin — явный вход в панель. Для не-админа работает только как первичная
// настройка (если админы ещё нигде не заданы), иначе просто отказ.
bot.command('admin', async (ctx) => {
  if (isAdmin(ctx.from)) return showAdminPanel(ctx);
  if (!HAS_EXPLICIT_ADMINS && MAX_AUTO_ADMINS > 0 && store.getAutoAdmins().length < MAX_AUTO_ADMINS) {
    store.addAutoAdmin(ctx.from.id);
    await ctx.reply('✅ Ты добавлен как администратор (первичная настройка).');
    return showAdminPanel(ctx);
  }
  if (ctx.chat?.type === 'private' && store.hasPendingAdminPhones()) {
    return ctx.reply(
      'Если администратор добавил тебя по номеру телефона, нажми кнопку ниже. Telegram отправит боту только твой собственный контакт для проверки.',
      { reply_markup: phoneConfirmKeyboard() }
    );
  }
  await ctx.reply('Эта команда только для администраторов.');
});

// /check — проверка своего доступа (для участников).
bot.command('check', async (ctx) => {
  const member = store.findMemberByUser(ctx.from.id);
  if (!member) { store.setFlow(ctx.from.id, 'awaiting_id'); await ctx.reply('Ты ещё не зарегистрирован 🙂\nПришли свой doTERRA ID (7–8 цифр) — и я проверю доступ.'); return; }
  await evaluateAndReply(ctx, member);
});

bot.command('whoami', (ctx) => ctx.reply(`🆔 Твой Telegram user_id: ${ctx.from.id}`));

// Узнать ID чата: напиши /id прямо в нужном чате (бот должен быть там участником/
// админом). Пригодится, чтобы вписать TIERn_ID в .env.
bot.command(['id', 'chatid'], (ctx) => {
  const title = ctx.chat.title ? `\nНазвание: ${ctx.chat.title.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}` : '';
  return ctx.reply(`🆔 ID этого чата: <code>${ctx.chat.id}</code>\nТип: ${ctx.chat.type}${title}`, { parse_mode: 'HTML' });
});

bot.command('help', (ctx) => {
  if (isAdmin(ctx.from)) {
    return ctx.reply('🛠 Команды администратора:\n\n• /admin — открыть панель\n• /addadmin <ID | @username | +телефон> — добавить администратора\n• /admins — показать список администраторов\n• /rebind <ID> <user_id> — перепривязать doTERRA ID на другой аккаунт\n• /unbind <ID> — снять привязку и убрать из чатов\n• /whoami — узнать свой user_id\n\nОбновление подписчиков и списки — в меню /admin.');
  }
  return ctx.reply('Я открываю доступ в чаты «Бережное врачевание» по баллам doTERRA.\n\n• /start — зарегистрироваться\n• /check — проверить свой доступ\n\nНужно прислать свой doTERRA ID (7–8 цифр).');
});

// ─────────────────────────────────────────────────────────────────────────
//  АДМИНСКИЕ КОМАНДЫ
// ─────────────────────────────────────────────────────────────────────────
bot.command('addadmin', async (ctx) => {
  if (!isAdmin(ctx.from)) return ctx.reply('Эта команда только для администраторов.');
  if (ctx.chat?.type !== 'private') return ctx.reply('Для безопасности добавляй администраторов только в личном чате с ботом.');

  const target = parseAdminTarget(ctx.match || '');
  if (!target.ok) {
    return ctx.reply(
      `${target.error}\n\nПримеры:\n/addadmin 765332286\n/addadmin @marina_nastavnik2810\n/addadmin phone +79991234567`
    );
  }

  if (target.type === 'id') {
    const result = store.addAdminId(target.value);
    return ctx.reply(result.added
      ? `✅ Администратор ${target.display} добавлен. Он может сразу открыть /admin.`
      : `ℹ️ ${target.display} уже есть среди добавленных администраторов.`);
  }
  if (target.type === 'username') {
    const result = store.addAdminUsername(target.value);
    return ctx.reply(result.added
      ? `✅ Администратор ${target.display} добавлен. Доступ действует, пока у аккаунта этот username.`
      : `ℹ️ ${target.display} уже есть среди добавленных администраторов.`);
  }

  const result = store.addAdminPhone(target.value);
  return ctx.reply(result.added
    ? `✅ Номер ${target.display} добавлен на подтверждение.\n\nПусть человек откроет этого бота, отправит /admin и нажмёт «📱 Отправить мой номер». После совпадения бот запомнит его Telegram ID и удалит номер из базы.`
    : `ℹ️ Номер ${target.display} уже ожидает подтверждения.`);
});

bot.command('admins', async (ctx) => {
  if (!isAdmin(ctx.from)) return ctx.reply('Эта команда только для администраторов.');
  if (ctx.chat?.type !== 'private') return ctx.reply('Список администраторов доступен только в личном чате с ботом.');
  return ctx.reply(adminListText());
});

bot.command('rebind', async (ctx) => {
  if (!isAdmin(ctx.from)) return ctx.reply('Эта команда только для администраторов.');
  const [doterraId, newUid] = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  if (!/^\d{6,9}$/.test(doterraId || '') || !/^\d{5,}$/.test(newUid || '')) {
    return ctx.reply('Перепривязать:\n/rebind <doTERRA ID> <новый user_id>\nНапример: /rebind 18170008 123456789\nНовый user_id: пусть человек напишет боту /whoami.');
  }
  const member = store.getMember(doterraId);
  if (!member) return ctx.reply(`ID ${doterraId} ещё никем не занят — привязывать нечего.`);
  const newUidNum = Number(newUid);
  const conflict = store.findMemberByUser(newUidNum);
  if (conflict && conflict.doterraId !== doterraId) return ctx.reply(`У аккаунта ${newUid} уже привязан ID ${conflict.doterraId}. Сначала /unbind ${conflict.doterraId}`);
  if (member.userId && member.userId !== newUidNum) await kickFromAllTiers(member);
  store.rebindMember(doterraId, newUidNum);
  await ctx.reply(`✅ ID ${doterraId} перепривязан на аккаунт ${newUid}. Прежний доступ отозван. Пусть новый аккаунт напишет боту /check.`);
});

bot.command('unbind', async (ctx) => {
  if (!isAdmin(ctx.from)) return ctx.reply('Эта команда только для администраторов.');
  const id = (ctx.match || '').trim();
  if (!/^\d{6,9}$/.test(id)) return ctx.reply('Освободить ID:\n/unbind <doTERRA ID>');
  const member = store.getMember(id);
  if (!member) return ctx.reply(`ID ${id} не привязан.`);
  await kickFromAllTiers(member);
  store.unbindMember(id);
  await ctx.reply(`✅ ID ${id} освобождён, доступ во все чаты отозван.`);
});

// Единый страж для всех админских инлайн-кнопок (adm_*): не-админа не пускаем.
bot.on('callback_query:data', async (ctx, next) => {
  if (ctx.callbackQuery.data.startsWith('adm_') && !isAdmin(ctx.from)) {
    return ctx.answerCallbackQuery('Только для администратора.');
  }
  await next();
});

bot.callbackQuery('adm_admins', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(adminListText(), { reply_markup: new InlineKeyboard().text('◀️ Назад', 'adm_back') });
});

// «Обновить подписчиков» → выбор чата (тира)
bot.callbackQuery('adm_update', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!TIERS.length) return ctx.reply('Чаты не настроены (TIER1_NAME… в .env).', { reply_markup: mainMenu() });
  const kb = new InlineKeyboard();
  TIERS.forEach((t) => kb.text(`${t.name} (от ${t.threshold})`, `adm_tier:${t.key}`).row());
  kb.text('❌ Отмена', 'adm_cancel');
  await ctx.reply('📋 Какой чат обновляем? У каждого свой порог баллов:', { reply_markup: kb });
});

bot.callbackQuery(/^adm_tier:(\w+)$/, async (ctx) => {
  const tier = tierByKey(ctx.match[1]);
  await ctx.answerCallbackQuery();
  if (!tier) return ctx.reply('Чат не найден.', { reply_markup: mainMenu() });
  store.startImport(ctx.from.id, tier.key);
  await ctx.reply(
    `📊 Обновляем «${tier.name}» (порог ${tier.threshold} баллов).\n\n📥 Пришли CSV-файл из расширения. Если кабинета два — присылай оба по очереди, потом жми «Посчитать на вылет».`,
    { reply_markup: new InlineKeyboard().text('✅ Посчитать на вылет', 'adm_calc').text('❌ Отмена', 'adm_cancel') }
  );
});

// ── Авто-пуш из расширения: входящие + уведомление ──────────────────────────
// Кому слать пуш о новых данных: явные ADMIN_IDS + авто-админы. Тех, кто задан
// только по @username (без user_id), написать нельзя — они увидят данные в меню.
function adminUserIds() {
  const ids = new Set(store.getAdminAccess().ids);
  for (const id of ADMIN_IDS) ids.add(id);
  return [...ids];
}

async function notifyAdminsOfPush(summary) {
  const kb = new InlineKeyboard();
  TIERS.forEach((t) => kb.text(`Проверить: ${t.name} (от ${t.threshold})`, `adm_pushtier:${t.key}`).row());
  kb.text('🔕 Позже', 'adm_dismiss_push');
  const text =
    `📲 <b>Пришли данные из расширения</b>\n` +
    (summary?.month ? `📅 ${escHtml(summary.month)}\n` : '') +
    `👥 Всего: ${summary?.total ?? '?'} · PV≥50: ${summary?.ge50 ?? '?'} · выгрузок в наборе: ${summary?.cabinets ?? 1}\n\n` +
    `Проверить чат на вылет:`;
  const ids = adminUserIds();
  if (!ids.length) { console.log('ingest: некому слать пуш (нет ADMIN_IDS/авто-админов).'); return; }
  for (const uid of ids) {
    try { await tgRetry(() => bot.api.sendMessage(uid, text, { parse_mode: 'HTML', reply_markup: kb })); }
    catch (e) { console.error('пуш админу', uid, e.message); }
  }
}

async function showInbox(ctx) {
  const box = store.getInbox();
  if (!box || !box.total) {
    return ctx.reply('📲 Пока данных из расширения нет.\n\nОткрой в doTERRA «Команда → Структура», нажми «Экспорт» в расширении — данные сами прилетят сюда.', { reply_markup: mainMenu() });
  }
  const kb = new InlineKeyboard();
  TIERS.forEach((t) => kb.text(`Проверить: ${t.name} (от ${t.threshold})`, `adm_pushtier:${t.key}`).row());
  kb.text('◀️ Назад', 'adm_back');
  const when = box.receivedAt ? new Date(box.receivedAt).toLocaleString('ru-RU') : '—';
  await ctx.reply(
    `📲 Данные из расширения${box.month ? ' · ' + escHtml(box.month) : ''}\n` +
    `👥 Всего: ${box.total} · PV≥50: ${box.ge50 ?? '—'} · выгрузок: ${box.cabinets?.length || 1}\n` +
    `🕒 Получено: ${when}\n\nВыбери чат для проверки на вылет:`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
}

bot.callbackQuery('adm_inbox', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showInbox(ctx);
});

// Проверить выбранный чат по последним данным из расширения (без присланного файла).
bot.callbackQuery(/^adm_pushtier:(\w+)$/, async (ctx) => {
  const tier = tierByKey(ctx.match[1]);
  await ctx.answerCallbackQuery();
  if (!tier) return ctx.reply('Чат не найден.', { reply_markup: mainMenu() });
  if (!store.startImportFromInbox(ctx.from.id, tier.key)) {
    return ctx.reply('Пока нет данных из расширения. Нажми «Экспорт» в расширении doTERRA — они прилетят сюда сами.', { reply_markup: mainMenu() });
  }
  await calcAndShow(ctx);
});

bot.callbackQuery('adm_dismiss_push', async (ctx) => {
  await ctx.answerCallbackQuery('Ок! Данные сохранены. Открой /admin, когда будешь готов проверить.');
});

bot.callbackQuery('adm_list', async (ctx) => {
  const members = store.listMembers();
  await ctx.answerCallbackQuery();
  if (!members.length) return ctx.reply('Пока никто не зарегистрирован.');
  const lines = members.map((m) => {
    const pv = store.getPoints(m.doterraId);
    const inT = TIERS.filter((t) => m.tiers?.[t.key] === 'in').map((t) => t.key);
    const invT = TIERS.filter((t) => m.tiers?.[t.key] === 'invited').map((t) => t.key);
    const badge = inT.length ? `🟢${inT.join(',')}` : invT.length ? `🟡${invT.join(',')}` : '⚪️';
    return `${badge} ${m.name || '—'} · ${m.doterraId} · ${fmtPv(pv)}`;
  });
  const head = `👥 Участники (${members.length})\n🟢 — в чате · 🟡 — приглашён · ⚪️ — ждёт баллов\n\n`;
  let body = lines.join('\n');
  if ((head + body).length > 3800) body = lines.slice(0, 60).join('\n') + `\n… и ещё ${members.length - 60}`;
  await ctx.reply(head + body);
});

bot.callbackQuery('adm_status', async (ctx) => {
  const members = store.listMembers();
  await ctx.answerCallbackQuery();
  const perTier = TIERS.map((t) => `• ${t.name} (от ${t.threshold}): ${members.filter((m) => m.tiers?.[t.key] === 'in').length} в чате`).join('\n');
  await ctx.reply(
    `ℹ️ Статус\n\n👥 Зарегистрировано: ${members.length}\n${perTier || '(чаты не настроены)'}\n\n⭐️ Снимок баллов: ${Object.keys(store.getData().points).length} записей.`
  );
});

bot.callbackQuery('adm_cancel', async (ctx) => {
  store.clearImport();
  await ctx.answerCallbackQuery('Отменено');
  await ctx.reply('Отменено.', { reply_markup: mainMenu() });
});

// Кто в чатах НЕ зарегистрирован: из тех, кого бот видел (писал/входил) + админы
// чата. Полного списка участников Telegram боту не даёт — молчунов тут не будет.
bot.callbackQuery('adm_unreg', async (ctx) => {
  await ctx.answerCallbackQuery();
  const seen = store.listSeen();
  const htmlBlocks = [], plainBlocks = [];
  for (const t of TIERS) {
    if (!t.id) continue;
    const people = new Map(); // userId -> { userId, name, username, admin }
    for (const s of seen) {
      if (!s.tiers?.[t.key]) continue;
      if (store.findMemberByUser(s.userId)) continue;          // уже привязан
      if (isAdmin({ id: s.userId, username: s.username })) continue; // управляющий бота
      people.set(s.userId, { userId: s.userId, name: s.name, username: s.username });
    }
    try {
      for (const a of await bot.api.getChatAdministrators(t.id)) {
        const u = a.user;
        if (u.is_bot || people.has(u.id) || store.findMemberByUser(u.id) || isAdmin({ id: u.id, username: u.username })) continue;
        people.set(u.id, { userId: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(' '), username: u.username, admin: true });
      }
    } catch {}
    let total = null;
    try { total = await bot.api.getChatMemberCount(t.id); } catch {}
    const registeredIn = store.listMembers().filter((m) => m.tiers?.[t.key] === 'in').length;
    const unlinked = total != null ? Math.max(0, total - 1 - registeredIn) : null;
    const list = [...people.values()];
    const silent = unlinked != null ? Math.max(0, unlinked - list.length) : null;
    const countPart = `в чате ${total ?? '?'}` + (unlinked != null ? `, без привязки ~${unlinked}` : '');
    const seenLine = `👀 Знаю по имени — ${list.length}` + (silent ? ` (ещё ~${silent} молчат, их не видно)` : '') + ':';
    const htmlList = list.length ? renderPeople(list, (p) => `• ${mention(p.userId, p.name)}${p.username ? ' @' + escHtml(p.username) : ''}${p.admin ? ' (админ чата)' : ''}`) : '—';
    const plainList = list.length ? renderPeople(list, (p) => `• ${plainName(p)}${p.admin ? ' (админ чата)' : ''}`) : '—';
    htmlBlocks.push(`«${escHtml(t.name)}» — ${countPart}\n${seenLine}\n${htmlList}`);
    plainBlocks.push(`«${t.name}» — ${countPart}\n${seenLine}\n${plainList}`);
  }
  const footer = '\n\nℹ️ По именам видны только те, кто писал/входил при боте или админы. Чтобы «вытащить» молчунов — попроси всех что-нибудь написать в чате.';
  const html = (htmlBlocks.join('\n\n') || 'Чаты не настроены.') + footer;
  const plain = (plainBlocks.join('\n\n') || 'Чаты не настроены.') + footer;
  try { await ctx.reply(html, { parse_mode: 'HTML', reply_markup: mainMenu() }); }
  catch (e) { console.error('adm_unreg', e.message); await ctx.reply(plain.slice(0, 4000), { reply_markup: mainMenu() }); }
});

// ── Отвязка участника кнопкой ──
bot.callbackQuery('adm_unbind_start', async (ctx) => {
  adminState.set(ctx.from.id, { step: 'await_unbind_id' });
  await ctx.answerCallbackQuery();
  await ctx.reply('Введите ID doTERRA участника:', { reply_markup: new InlineKeyboard().text('◀️ Назад', 'adm_back') });
});
bot.callbackQuery('adm_back', async (ctx) => {
  adminState.delete(ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.reply('Меню:', { reply_markup: mainMenu() });
});
bot.callbackQuery(/^adm_do_unbind:(\d{6,9})$/, async (ctx) => {
  const id = ctx.match[1];
  await ctx.answerCallbackQuery();
  const m = store.getMember(id);
  if (!m) return ctx.reply('Уже отвязан или не найден.', { reply_markup: mainMenu() });
  await kickFromAllTiers(m);
  store.unbindMember(id);
  await ctx.reply(`✅ Аккаунт отвязан от ID ${id}, доступ во все чаты отозван.`, { reply_markup: mainMenu() });
});

// Приём CSV (только админ; файл качаем токеном этого же бота)
bot.on('message:document', async (ctx) => {
  if (!isAdmin(ctx.from)) return;
  const session = store.getImport();
  if (!session || !session.tier) { await ctx.reply('Сначала «📥 Обновить подписчиков» и выбери чат.', { reply_markup: mainMenu() }); return; }
  const tier = tierByKey(session.tier);
  try {
    const file = await ctx.getFile();
    const resp = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    if (Number(resp.headers.get('content-length') || 0) > 5_000_000) throw new Error('файл слишком большой');
    const rows = parseCSV(await resp.text());
    const det = detectColumns(rows);
    if (det.idIdx < 0 || det.pointsIdx < 0) { await ctx.reply('Не нашёл колонки ID и PV. Это файл от расширения?'); return; }
    const added = store.addImportFile(ctx.message.document.file_name || 'csv', extractRecords(rows, det.idIdx, det.pointsIdx));
    const sess = store.getImport();
    const inTier = store.listMembers().filter((m) => m.tiers?.[session.tier] === 'in');
    const missing = inTier.filter((m) => !(m.doterraId in sess.points));
    const warn = missing.length ? `\n⚠️ ${missing.length} из ${inTier.length} в чате нет в файле (возможно, второй кабинет). Пришли второй файл или жми «Посчитать» — их не тронем.` : '';
    await ctx.reply(`✅ «${tier?.name}»: файл принят — ${added} строк (файлов: ${sess.files.length}).${warn}`, {
      reply_markup: new InlineKeyboard().text('✅ Посчитать на вылет', 'adm_calc').text('❌ Отмена', 'adm_cancel'),
    });
  } catch (e) { await ctx.reply('Ошибка чтения файла: ' + e.message); }
});

async function calcAndShow(ctx) {
  const session = store.getImport();
  const tier = tierByKey(session?.tier);
  if (!session || !session.files.length || !tier) return ctx.reply('Сначала выбери чат и пришли данные.', { reply_markup: mainMenu() });

  // Сверяем реальное членство перед подсчётом: кто из привязанных сейчас в чате.
  let note = '';
  if (tier.id) {
    await ctx.reply('🔄 Проверяю, кто сейчас в чате…');
    const { inside } = await syncTierMembership(tier);
    let total = null;
    try { total = await bot.api.getChatMemberCount(tier.id); } catch {}
    note = `👥 В чате: ${total ?? '?'} · привязано к боту: ${inside}\n`;
    if (total != null && total - 1 > inside) note += `⚠️ ${total - 1 - inside} чел. без привязки — их не проверить по баллам (пусть напишут боту свой doTERRA ID).\n\n`;
    else note += '\n';
  }

  const pointsMap = new Map(Object.entries(session.points));
  const inTier = store.listMembers().filter((m) => m.tiers?.[session.tier] === 'in');
  const { toRemove, missing } = classify(inTier, pointsMap, tier.threshold);
  store.setReviewed(toRemove.map((m) => ({ doterraId: m.doterraId, userId: m.userId, pv: m.pv })));

  // Кого пригласим: привязанные, кто набрал порог и ещё не в чате/не приглашён.
  const toInvite = store.listMembers().filter((m) => {
    if (m.tiers?.[tier.key]) return false;
    const pv = pointsMap.get(m.doterraId);
    return !!tier.id && pv != null && pv >= tier.threshold;
  });
  const inviteHtml = toInvite.length
    ? `\n\n➕ <b>Пригласим</b> (набрали ${tier.threshold}+) — ${toInvite.length}:\n` +
      renderPeople(toInvite, (m, i) => `${i + 1}. ${mention(m.userId, m.name)}${m.username ? ' @' + escHtml(m.username) : ''} · ${pointsMap.get(m.doterraId)} б.`)
    : '';
  const invitePlain = toInvite.length
    ? `\n\n➕ Пригласим — ${toInvite.length}:\n` + renderPeople(toInvite, (m, i) => `${i + 1}. ${plainName(m)} · ${pointsMap.get(m.doterraId)} б.`)
    : '';

  const kb = applyKeyboard(toRemove.length, toInvite.length);

  if (!toRemove.length) {
    const body = inTier.length === 0
      ? `«${escHtml(tier.name)}»: под удаление никто не попал — в чате нет ни одного привязанного участника.`
      : `«${escHtml(tier.name)}»: удалять некого — все привязанные в чате набрали ${tier.threshold}+.`;
    const tail = missing.length ? `\n(${missing.length} без данных — не тронуты.)` : '';
    try { await ctx.reply(note + body + tail + inviteHtml, { parse_mode: 'HTML', reply_markup: kb }); }
    catch (e) { console.error('adm_calc', e.message); await ctx.reply((note + body + tail + invitePlain).slice(0, 4000), { reply_markup: kb }); }
    return;
  }
  const missTail = missing.length ? `\n\n⚠️ Без данных, не тронем: ${missing.length}` : '';
  const listHtml = renderPeople(toRemove, (m, i) => `${i + 1}. ${mention(m.userId, m.name)}${m.username ? ' @' + escHtml(m.username) : ''} · ${m.pv} б.`);
  const listPlain = renderPeople(toRemove, (m, i) => `${i + 1}. ${plainName(m)} · ${m.pv} б.`);
  const html = note + `❌ <b>На вылет</b> из «${escHtml(tier.name)}» — ${toRemove.length} (баллов &lt; ${tier.threshold}):\n${listHtml}` + missTail + inviteHtml + `\n\nВыбери действие:`;
  const plain = note + `❌ На вылет из «${tier.name}» — ${toRemove.length} (баллов < ${tier.threshold}):\n${listPlain}` + missTail + invitePlain + `\n\nВыбери действие:`;
  try { await ctx.reply(html, { parse_mode: 'HTML', reply_markup: kb }); }
  catch (e) { console.error('adm_calc', e.message); await ctx.reply(plain.slice(0, 4000), { reply_markup: kb }); }
}
bot.callbackQuery('adm_calc', async (ctx) => { await ctx.answerCallbackQuery(); await calcAndShow(ctx); });

// Приглашаем в тир всех, кто набрал его порог и ещё не в нём/не приглашён.
async function reinviteTier(pointsMap, tier) {
  let invited = 0;
  for (const m of store.listMembers()) {
    if (m.tiers?.[tier.key]) continue; // уже in или invited
    const pv = pointsMap.get(m.doterraId);
    if (pv != null && pv >= tier.threshold && tier.id) {
      const link = await inviteLink(m, tier);
      if (link) {
        store.setTierState(m.doterraId, tier.key, 'invited');
        try { await bot.api.sendMessage(m.userId, `🎉 Ты набрал нужные баллы! Открылся доступ в «${tier.name}»:\n${link}`); } catch {}
        invited++; await sleep(300);
      }
    }
  }
  return invited;
}

// Применяем импорт к тиру: всегда обновляем баллы; при remove — удаляем «на
// вылет»; при invite — приглашаем набравших порог. Три кнопки = комбинации флагов.
async function applyImport(ctx, { remove, invite }) {
  const session = store.getImport();
  const tier = tierByKey(session?.tier);
  if (!session || !session.files.length || !tier) { await ctx.answerCallbackQuery('Нет данных.'); return ctx.reply('Нет активного импорта.', { reply_markup: mainMenu() }); }
  if (remove && !session.reviewed) { await ctx.answerCallbackQuery('Сначала «Посчитать».'); return ctx.reply('Сначала «Посчитать на вылет», потом удаляй.', { reply_markup: mainMenu() }); }
  if (applying) { await ctx.answerCallbackQuery('Уже выполняется, подожди…'); return; }
  applying = true; await ctx.answerCallbackQuery();
  try {
    const pointsMap = new Map(Object.entries(session.points));
    if (pointsMap.size) store.commitPoints(pointsMap);
    let removed = 0, skipped = 0;
    if (remove) {
      await ctx.reply(`⏳ «${tier.name}»: удаляю до ${session.reviewed.length}…`);
      for (const r of session.reviewed) {
        const m = store.getMember(r.doterraId);
        const pv = pointsMap.has(r.doterraId) ? pointsMap.get(r.doterraId) : null;
        if (!m || m.tiers?.[tier.key] !== 'in' || pv == null || !(pv < tier.threshold)) { skipped++; continue; }
        const { banned } = await banFromTier(m.userId, tier);
        if (banned) {
          store.setTierState(m.doterraId, tier.key, null);
          removed++;
          try { await bot.api.sendMessage(m.userId, `😔 Доступ в «${tier.name}» приостановлен.\n\nУ тебя ${pv}, а нужно ${tier.threshold} баллов. Наберёшь — нажми /check, и я снова открою.`); } catch {}
        }
        await sleep(350);
      }
    }
    const invited = invite ? await reinviteTier(pointsMap, tier) : 0;
    store.clearImport();
    let msg = `✅ Готово по «${tier.name}»:`;
    if (remove) msg += `\n🗑 Удалено: ${removed}` + (skipped ? ` (пропущено ${skipped})` : '');
    if (invite) msg += `\n🎉 Приглашено: ${invited}`;
    if (!remove && !invite) msg += `\n⭐️ Баллы обновлены.`;
    await ctx.reply(msg, { reply_markup: mainMenu() });
  } catch (e) { console.error('applyImport', e.message); await ctx.reply('Ошибка: ' + e.message, { reply_markup: mainMenu() }); }
  finally { applying = false; }
}

bot.callbackQuery('adm_del', (ctx) => applyImport(ctx, { remove: true, invite: false }));           // только удалить
bot.callbackQuery(['adm_inv', 'adm_commit'], (ctx) => applyImport(ctx, { remove: false, invite: true })); // только пригласить
bot.callbackQuery(['adm_both', 'adm_confirm'], (ctx) => applyImport(ctx, { remove: true, invite: true })); // удалить + пригласить

// ─────────────────────────────────────────────────────────────────────────
//  ТЕКСТ И СОБЫТИЯ ЧАТА
// ─────────────────────────────────────────────────────────────────────────
bot.on('message:contact', async (ctx) => {
  if (ctx.chat?.type !== 'private') return;
  const contact = ctx.message.contact;
  const removeKeyboard = { remove_keyboard: true };
  if (!contact?.user_id || contact.user_id !== ctx.from.id) {
    await ctx.reply('Нужно нажать кнопку «📱 Отправить мой номер» и отправить именно свой контакт.', { reply_markup: removeKeyboard });
    return;
  }
  const claimed = store.claimAdminPhone(ctx.from, contact.phone_number);
  if (!claimed.ok) {
    await ctx.reply('Этот номер не ожидает подтверждения администратора. Доступ не выдан.', { reply_markup: removeKeyboard });
    return;
  }
  await ctx.reply('✅ Номер подтверждён. Ты добавлен как администратор.', { reply_markup: removeKeyboard });
  await showAdminPanel(ctx);
});

bot.on('message:text', async (ctx) => {
  if (ctx.chat?.type !== 'private') return; // регистрация/отвязка — только в личке, не в группах
  // 1) Админ вводит ID для отвязки — этот шаг в приоритете.
  const st = adminState.get(ctx.from.id);
  if (isAdmin(ctx.from) && st?.step === 'await_unbind_id') {
    const id = ctx.message.text.trim();
    if (!/^\d{6,9}$/.test(id)) { await ctx.reply('Нужен номер ID (6–9 цифр). Или «Назад».', { reply_markup: new InlineKeyboard().text('◀️ Назад', 'adm_back') }); return; }
    adminState.delete(ctx.from.id);
    const m = store.getMember(id);
    if (!m) { await ctx.reply(`ID ${id} ни к кому не привязан.`, { reply_markup: mainMenu() }); return; }
    const tg = m.username ? '@' + m.username : '(без username)';
    const inT = TIERS.filter((t) => m.tiers?.[t.key] === 'in').map((t) => t.name).join(', ') || '—';
    const pv = store.getPoints(id);
    await ctx.reply(
      `🔗 Привязка ID ${id}\nИмя: ${m.name || '—'}\nTelegram: ${tg}\nuser_id: ${m.userId}\nБаллы: ${fmtPv(pv)}\nВ чатах: ${inT}`,
      { reply_markup: new InlineKeyboard().text('◀️ Назад', 'adm_back').text('🔓 Отвязать', `adm_do_unbind:${id}`) }
    );
    return;
  }

  // 2) Обычный поток участника: приём doTERRA ID.
  const text = ctx.message.text.trim();
  if (/^\d{6,9}$/.test(text)) {
    const owner = store.getMember(text);
    if (owner && owner.userId !== ctx.from.id) {
      await ctx.reply(`⛔️ ID ${text} уже привязан к другому Telegram-аккаунту.\n\nЕсли это твой ID — напиши администратору, поможем.`);
      return;
    }
    const member = store.registerMember(text, ctx.from);
    await evaluateAndReply(ctx, member);
    return;
  }
  const flow = store.getFlow(ctx.from.id);
  if (flow?.step === 'awaiting_id') { await ctx.reply('Хм, это не похоже на ID 🤔\nПришли только цифры — обычно 7–8, например 18170008.'); return; }
  const member = store.findMemberByUser(ctx.from.id);
  await ctx.reply(member ? 'Чтобы проверить доступ — нажми /check. Или пришли новый ID, если нужно исправить.' : 'Чтобы начать — нажми /start, я подскажу, что делать.');
});

// Фактический вход/выход в чате тира → источник правды членства.
bot.on('chat_member', (ctx) => {
  const t = tierByChat(ctx.chat?.id);
  if (!t) return;
  const user = ctx.chatMember.new_chat_member?.user;
  const status = ctx.chatMember.new_chat_member?.status;
  const inside = status === 'member' || status === 'administrator' || status === 'creator';
  if (user && inside) store.recordSeen(user, t.key); // вошедшего тоже запоминаем
  const member = user && store.findMemberByUser(user.id);
  if (!member) return;
  store.setTierState(member.doterraId, t.key, inside ? 'in' : null);
});

// Бота добавили в чат / сменили статус → печатаем id чата в лог хостинга.
// Удобно, чтобы узнать TIERn_ID сразу после добавления бота в чат.
bot.on('my_chat_member', (ctx) => {
  const c = ctx.chat;
  const status = ctx.myChatMember?.new_chat_member?.status;
  console.log(`ℹ️ Чат: id=${c.id} type=${c.type} status=${status} title=${JSON.stringify(c.title || '')}`);
});

// ─────────────────────────────────────────────────────────────────────────
// HTTP-приём данных из расширения (авто-пуш). Поднимается только если задан
// порт (PORT/INGEST_PORT) и секрет (INGEST_SECRET). Иначе — тихо выключен,
// бот работает как раньше (приём CSV файлом остаётся).
startIngestServer({
  port: Number(process.env.PORT || process.env.INGEST_PORT || 0),
  secret: process.env.INGEST_SECRET || '',
  onPush: async (rows, meta) => {
    const summary = store.ingestInbox(rows, meta);
    await notifyAdminsOfPush(summary);
    return summary;
  },
});

bot.catch((err) => console.error('bot:', err.error?.message || err.message));
bot.start({
  allowed_updates: ['message', 'callback_query', 'chat_member', 'my_chat_member'],
  onStart: () => console.log('✓ Бот запущен (участники + админка в одном)'),
});
