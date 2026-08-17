import 'dotenv/config';
import { Bot, InlineKeyboard, InputFile, Keyboard } from 'grammy';
import { parseCSV, detectColumns, extractRecords } from './csv.js';
import { classify } from './logic.js';
import { parseAdminTarget } from './admin-access.js';
import * as store from './store.js';
import { startIngestServer } from './ingest.js';
import {
  billingPeriod,
  formatRub,
  paymentDeadlinePassed,
  paymentIsPaid,
  periodLabel,
  teamLabel,
  TEAM_GUEST,
} from './billing.js';
import { parseUploadCsvMeta, resolveUploadMeta } from './upload-meta.js';

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

// isAdminBase — есть ли права в принципе; isAdmin — пользуется ли ими сейчас.
// Разделены ради /adminoff: он не отбирает права, а лишь прячет панель, поэтому
// вернуть их через /admin можно всегда, даже когда прав из .env не отнять.
const isAdminBase = (u) =>
  !!u && (ADMIN_IDS.has(u.id) || (u.username && ADMIN_USERNAMES.has(u.username.toLowerCase())) || store.isStoredAdmin(u));
const isAdmin = (u) => isAdminBase(u) && !store.isAdminOff(u.id);
const fmtPv = (pv) => (pv == null ? '—' : pv);
const fmtDate = (iso) => iso ? new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }) : '—';
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

function isMemberInside(member) {
  return TIERS.some((tier) => member?.tiers?.[tier.key] === 'in');
}

function paymentAccess(member, now = new Date()) {
  const team = store.getMemberTeam(member.doterraId);
  if (team !== TEAM_GUEST) return { team, required: false, paid: true, mayInvite: true, inGrace: false, record: null };
  const period = billingPeriod(now);
  const record = store.ensurePayment(member.doterraId, period, now);
  const paid = paymentIsPaid(record);
  const inGrace = !paid && isMemberInside(member) && !paymentDeadlinePassed(record, now);
  return { team, period, required: true, paid, mayInvite: paid, inGrace, record };
}

function paymentClaimKeyboard(period) {
  return new InlineKeyboard().text('✅ Я оплатил(а)', `pay_claim:${period}`);
}

// По текущим баллам и оплате приглашаем участника во все доступные чаты.
async function admit(member) {
  const pv = store.getPoints(member.doterraId);
  const payment = paymentAccess(member);
  const res = { pv, payment, links: [], inNow: [], lack: [], soon: [], paymentBlocked: [] };
  if (pv == null) return res;
  for (const t of TIERS) {
    const fresh = store.getMember(member.doterraId) || member;
    const state = fresh.tiers?.[t.key];
    if (pv >= t.threshold) {
      if (state === 'in') { res.inNow.push(t.name); continue; }
      if (!payment.mayInvite) { res.paymentBlocked.push(t.name); continue; }
      // Уже в чате (например, вступил до бота)? Пометим 'in' и не шлём лишнюю ссылку.
      if (t.id && isInsideStatus(await chatMemberStatus(t, fresh.userId))) {
        store.setTierState(fresh.doterraId, t.key, 'in'); res.inNow.push(t.name); continue;
      }
      const link = await inviteLink(fresh, t);
      if (link) { res.links.push(`${t.name}: ${link}`); store.setTierState(fresh.doterraId, t.key, 'invited'); }
      else res.soon.push(t.name); // чат ещё не подключён
    } else {
      res.lack.push(`«${t.name}» — нужно ${t.threshold}, не хватает ${Math.round((t.threshold - pv) * 10) / 10}`);
    }
  }
  return res;
}

async function evaluateAndReply(ctx, member) {
  const r = await admit(member);
  // Баллов нет в снимке — человек зарегистрировался между обновлениями базы.
  // Это норма в середине месяца, поэтому объясняем, а не отделываемся «ждите».
  if (r.pv == null) {
    await ctx.reply(
      `✅ Принято! ID ${member.doterraId} привязан к твоему аккаунту.\n\n` +
        `Твоих баллов у меня пока нет: список подтягивают из кабинета doTERRA примерно раз в месяц. ` +
        `Как только баллы появятся и их хватит — я сам пришлю ссылку, ничего делать не нужно.\n\n` +
        `Хочешь проверить раньше — нажми /check.`
    );
    return;
  }
  let msg = '';
  msg += `👥 Команда: ${teamLabel(r.payment.team)}\n`;
  if (r.links.length) msg += `🎉 Доступ открыт! Заходи по ссылке:\n\n${r.links.join('\n')}\n\n⏳ Ссылка личная, работает сутки и только один раз. Не успел — нажми /check, пришлю новую.\n\n`;
  if (r.inNow.length) msg += `✅ Ты уже в: ${r.inNow.join(', ')}.\n`;
  if (r.soon.length) msg += `⏳ Доступ положен, но ${r.soon.join(', ')} ещё настраивается — загляни позже через /check.\n`;
  if (r.lack.length) msg += `📊 У тебя ${r.pv} балл(ов). Пока не хватает:\n• ${r.lack.join('\n• ')}\n\nНаберёшь — нажми /check, и я открою доступ.\n`;
  if (r.payment.required && !r.payment.paid && (r.paymentBlocked.length || r.inNow.length)) {
    const settings = store.getPaymentSettings();
    const state = r.payment.record?.status === 'claimed'
      ? '🙋 Сообщение об оплате уже отправлено администратору. Ожидай подтверждения.'
      : paymentDeadlinePassed(r.payment.record)
        ? '⚠️ Срок оплаты закончился. После подтверждения бот снова откроет доступ.'
        : `⏳ Подтвердить оплату нужно до ${fmtDate(r.payment.record?.dueAt)}.`;
    msg += `\n💳 Для команды «Гость» нужна ежемесячная оплата за ${periodLabel(r.payment.period)} — ${formatRub(settings.amountRub)}.\n${state}\n\n${settings.payDetails}`;
    const keyboard = r.payment.record?.status === 'claimed' ? undefined : paymentClaimKeyboard(r.payment.period);
    await ctx.reply(msg.trim(), keyboard ? { reply_markup: keyboard } : undefined);
    return;
  }
  if (r.payment.required && !r.payment.paid && r.lack.length) {
    msg += `\n💳 После набора нужных баллов для команды «Гость» потребуется ежемесячная оплата.`;
  }
  await ctx.reply((msg || `Твои баллы: ${r.pv}. Доступных чатов пока нет.`).trim());
}

// ─────────────────────────────────────────────────────────────────────────
//  ОБЩИЕ КОМАНДЫ (роль определяется по isAdmin)
// ─────────────────────────────────────────────────────────────────────────
function mainMenu() {
  return new InlineKeyboard()
    .text('🔄 Обновить список участников', 'adm_inbox').row()
    .text('📋 Список участников', 'adm_list').row()
    .text('💳 Оплата гостей', 'adm_payments').row()
    .text('👀 Кто не зарегистрирован', 'adm_unreg').row()
    .text('🔗 Отвязать участника', 'adm_unbind_start').row()
    .text('👑 Администраторы', 'adm_admins').row()
    .text('💾 Резервная копия БД', 'adm_backup').row()
    .text('ℹ️ Статус', 'adm_status');
}

// Кнопки под результатом «Посчитать»: удалить / пригласить / и то и то —
// показываем только применимые (по числу на вылет и на приглашение).
function applyKeyboard(nRemove, nInvite, { allowRemove = true } = {}) {
  const kb = new InlineKeyboard();
  if (!allowRemove) {
    if (nInvite) return kb.text(`➕ Пригласить (${nInvite})`, 'adm_inv').row().text('❌ Отмена', 'adm_cancel');
    return kb.text('✅ Обновить баллы', 'adm_inv').row().text('❌ Отмена', 'adm_cancel');
  }
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
// Сводка прямо в панели: обычно админ открывает её именно чтобы узнать, есть ли
// новые данные, — незачем ради этого ходить в «Статус».
function panelSummary() {
  const members = store.listMembers();
  const inChat = members.filter((m) => TIERS.some((t) => m.tiers?.[t.key] === 'in')).length;
  const box = store.getInbox();
  const period = billingPeriod();
  const claims = store.listPayments(period).filter((payment) => payment.status === 'claimed').length;
  const who = members.length ? `${members.length} · в чатах ${inChat}` : 'пока никого';
  const data = box?.total
    ? `${box.total} чел.${box.month ? ' за ' + escHtml(box.month) : ''} · выгрузок ${box.uploads} — доступны для проверки`
    : 'новых данных нет';
  return `👥 Участников: ${who}\n📥 Из расширения: ${data}\n💳 Оплаты: ${claims ? `ожидают подтверждения ${claims}` : 'новых заявок нет'}`;
}

const showAdminPanel = (ctx) =>
  ctx.reply(
    `🛠 <b>Админ-панель doTERRA</b>\n\n${panelSummary()}\n\nВыбери действие ↓  ·  ещё команды: /help`,
    { parse_mode: 'HTML', reply_markup: mainMenu() }
  );

const phoneConfirmKeyboard = () =>
  new Keyboard().requestContact('📱 Отправить мой номер').resized().oneTime();

async function sendDatabaseBackup(ctx) {
  if (ctx.chat?.type !== 'private') {
    return ctx.reply('Для безопасности резервную копию можно получить только в личном чате с ботом.');
  }
  const path = store.createBackupSnapshot(`admin-${ctx.from.id}`);
  const info = store.getStorageInfo();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await ctx.replyWithDocument(
    new InputFile(path, `doterra-bot-backup-${stamp}.json`),
    {
      caption: `💾 Резервная копия базы\n\nУчастников: ${info.members}\nСнимков на сервере: ${info.backups}\n\nХрани этот файл в закрытом месте: внутри есть Telegram ID и doTERRA ID участников.`,
    }
  );
}

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
    await ctx.reply(`✅ Ты уже зарегистрирован.\n\n🆔 doTERRA ID: ${existing.doterraId}\n👥 Команда: ${teamLabel(store.getMemberTeam(existing.doterraId))}\n⭐️ Баллы: ${fmtPv(pv)}\n\nНажми /check — проверю доступ в чаты. Ошибся с ID? Просто пришли правильный.`);
    return;
  }
  store.setFlow(ctx.from.id, 'awaiting_id');
  const doors = TIERS.map((t) => `• «${t.name}» — от ${t.threshold} баллов`).join('\n');
  await ctx.reply(
    `👋 Привет! Я открываю доступ в чаты «Бережное врачевание» по баллам doTERRA (PV за месяц).\n\n` +
      (doors ? `Куда можно попасть:\n${doors}\n\n` : '') +
      `👉 Пришли свой ID участника doTERRA — номер из личного кабинета, обычно 7–8 цифр. Например: 18170008\n\n` +
      `Найти его: кабинет doTERRA → «Мой офис», номер рядом с именем.`
  );
});

// /admin — явный вход в панель. Для не-админа работает только как первичная
// настройка (если админы ещё нигде не заданы), иначе просто отказ.
// Выключить себе панель: бот начнёт отвечать как обычному участнику. Удобно,
// чтобы проверить, что видят люди, не заводя второй аккаунт.
bot.command('adminoff', async (ctx) => {
  if (!isAdminBase(ctx.from)) return ctx.reply('У тебя и так нет админ-доступа.');
  if (store.isAdminOff(ctx.from.id)) return ctx.reply('🔒 Админка уже выключена. Включить обратно — /admin');
  store.setAdminOff(ctx.from.id, true);
  await ctx.reply(
    '🔒 <b>Админка выключена</b>\n\nТеперь я отвечаю тебе как обычному участнику — попробуй /start и /check.\n' +
      'Уведомления о новых данных тоже не приходят.\n\nВключить обратно: /admin',
    { parse_mode: 'HTML' }
  );
});

bot.command('admin', async (ctx) => {
  if (isAdminBase(ctx.from) && store.isAdminOff(ctx.from.id)) {
    store.setAdminOff(ctx.from.id, false);
    await ctx.reply('🔓 Админка включена обратно.');
    return showAdminPanel(ctx);
  }
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
    return ctx.reply('🛠 Команды администратора:\n\n• /admin — открыть панель\n• /adminoff — выключить себе админку и побыть обычным участником (обратно — /admin)\n• /backup — скачать резервную копию базы\n• /addadmin <ID | @username | +телефон> — добавить администратора\n• /admins — показать список администраторов\n• /rebind <ID> <user_id> — перепривязать doTERRA ID на другой аккаунт\n• /unbind <ID> — снять привязку и убрать из чатов\n• /whoami — узнать свой user_id\n\nВ меню /admin:\n• красные/зелёные обновления и управление 5 выгрузками;\n• «Оплата гостей» — сумма, реквизиты, срок и подтверждения;\n• «Кто не зарегистрирован» — ручной сбор и очистка регистраций.');
  }
  const doors = TIERS.map((t) => `• «${t.name}» — от ${t.threshold} баллов`).join('\n');
  return ctx.reply(
    `Я открываю доступ в чаты «Бережное врачевание» по баллам doTERRA (PV за месяц).\n\n` +
      (doors ? `Куда можно попасть:\n${doors}\n\n` : '') +
      `Команды:\n• /start — зарегистрироваться (нужен doTERRA ID, 7–8 цифр)\n• /check — проверить доступ и получить ссылку\n\n` +
      `Частые вопросы:\n` +
      `• Ссылка не открылась или истекла? Нажми /check — пришлю новую.\n` +
      `• Баллы набрал, а доступа нет? Список из кабинета обновляют примерно раз в месяц. Нажми /check — если баллы уже видны, открою сразу.\n` +
      `• Для команды «Гость» дополнительно нужна подтверждённая оплата за текущий месяц.\n` +
      `• Ошибся в ID? Просто пришли правильный номер.`
  );
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

bot.command('backup', async (ctx) => {
  if (!isAdmin(ctx.from)) return ctx.reply('Эта команда только для администраторов.');
  return sendDatabaseBackup(ctx);
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

bot.callbackQuery('adm_backup', async (ctx) => {
  await ctx.answerCallbackQuery();
  return sendDatabaseBackup(ctx);
});

// ── Авто-пуш из расширения: входящие + уведомление ──────────────────────────
// Кому слать пуш о новых данных: явные ADMIN_IDS + авто-админы. Тех, кто задан
// только по @username (без user_id), написать нельзя — они увидят данные в меню.
function adminUserIds() {
  const ids = new Set(store.getAdminAccess().ids);
  for (const id of ADMIN_IDS) ids.add(id);
  return [...ids].filter((id) => !store.isAdminOff(id)); // /adminoff глушит и уведомления
}

function paymentStatusText(record) {
  if (record?.status === 'paid') {
    const by = record.confirmedBy?.username ? `@${record.confirmedBy.username}` : record.confirmedBy?.name || 'администратор';
    return `✅ Подтверждено · ${fmtDate(record.confirmedAt)} · ${escHtml(by)}`;
  }
  if (record?.status === 'claimed') return `🙋 Участник сообщил об оплате · ${fmtDate(record.claimedAt)}`;
  if (record?.status === 'rejected') return `❌ Отклонено · ${fmtDate(record.rejectedAt)}`;
  return paymentDeadlinePassed(record) ? `🔴 Не оплачено · срок закончился ${fmtDate(record.dueAt)}` : `⏳ Ожидается до ${fmtDate(record?.dueAt)}`;
}

function paymentAdminText(member, record) {
  return (
    `💳 <b>Оплата команды «Гость»</b>\n\n` +
    `Участник: ${mention(member.userId, member.name)}${member.username ? ` @${escHtml(member.username)}` : ''}\n` +
    `doTERRA ID: <code>${escHtml(member.doterraId)}</code>\n` +
    `Период: ${escHtml(periodLabel(record.period))}\n` +
    `Сумма: ${formatRub(record.amountRub)}\n` +
    `PV: ${fmtPv(store.getPoints(member.doterraId))}\n\n` +
    paymentStatusText(record)
  );
}

function paymentAdminKeyboard(member, record) {
  const kb = new InlineKeyboard();
  if (record.status === 'paid') {
    return kb.text('↩️ Отменить подтверждение', `adm_paycancel:${member.doterraId}:${record.period}`);
  }
  return kb
    .text('✅ Подтвердить', `adm_payok:${member.doterraId}:${record.period}`)
    .text('❌ Отклонить', `adm_payno:${member.doterraId}:${record.period}`);
}

async function refreshPaymentAdminMessages(member, record) {
  for (const [adminId, messageId] of Object.entries(record.adminMessages || {})) {
    try {
      await tgRetry(() => bot.api.editMessageText(
        Number(adminId),
        Number(messageId),
        paymentAdminText(member, record),
        { parse_mode: 'HTML', reply_markup: paymentAdminKeyboard(member, record) }
      ));
    } catch {}
  }
}

async function notifyAdminsOfPaymentClaim(member, record) {
  const ids = adminUserIds();
  if (!ids.length) {
    console.log('payment: некому подтвердить оплату (нет ADMIN_IDS/авто-админов).');
    return;
  }
  for (const uid of ids) {
    try {
      const sent = await tgRetry(() => bot.api.sendMessage(uid, paymentAdminText(member, record), {
        parse_mode: 'HTML',
        reply_markup: paymentAdminKeyboard(member, record),
      }));
      store.setPaymentAdminMessage(member.doterraId, record.period, uid, sent.message_id);
    } catch (e) { console.error('уведомление об оплате', uid, e.message); }
  }
}

async function showPaymentsAdmin(ctx) {
  const settings = store.getPaymentSettings();
  const period = billingPeriod();
  const guests = store.listMembers().filter((member) => store.getMemberTeam(member.doterraId) === TEAM_GUEST);
  const records = guests.map((member) => store.getPayment(member.doterraId, period)).filter(Boolean);
  const paid = records.filter(paymentIsPaid).length;
  const claimed = records.filter((record) => record.status === 'claimed').length;
  const kb = new InlineKeyboard()
    .text('💰 Изменить сумму', 'adm_payamount').row()
    .text('🏦 Изменить реквизиты', 'adm_paydetails').row()
    .text('⏳ Изменить льготный срок', 'adm_paygrace').row()
    .text(`📋 Оплаты за месяц (${records.length})`, 'adm_paylist').row()
    .text('◀️ Назад', 'adm_back');
  await ctx.reply(
    `💳 <b>Оплата команды «Гость»</b>\n\n` +
    `Период: ${escHtml(periodLabel(period))}\n` +
    `Сумма: ${formatRub(settings.amountRub)}\n` +
    `Льготный срок: ${settings.graceDays} дн.\n` +
    `Гостей зарегистрировано: ${guests.length}\n` +
    `Подтверждено: ${paid} · ожидают проверки: ${claimed}\n\n` +
    `<b>Как оплатить:</b>\n${escHtml(settings.payDetails)}`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
}

async function showPaymentList(ctx) {
  const period = billingPeriod();
  const guests = store.listMembers().filter((member) => store.getMemberTeam(member.doterraId) === TEAM_GUEST);
  const rows = guests.map((member) => ({ member, record: store.ensurePayment(member.doterraId, period) }));
  const order = { claimed: 0, pending: 1, rejected: 2, paid: 3 };
  rows.sort((a, b) => (order[a.record.status] ?? 9) - (order[b.record.status] ?? 9) || String(a.member.name || '').localeCompare(String(b.member.name || '')));
  const lines = rows.slice(0, 40).map(({ member, record }, index) => {
    const icon = record.status === 'paid' ? '✅' : record.status === 'claimed' ? '🙋' : record.status === 'rejected' ? '❌' : paymentDeadlinePassed(record) ? '🔴' : '⏳';
    return `${index + 1}. ${icon} ${escHtml(member.name || '—')} · <code>${member.doterraId}</code> · ${formatRub(record.amountRub)}`;
  });
  const kb = new InlineKeyboard();
  rows.filter(({ record }) => record.status === 'claimed').slice(0, 15).forEach(({ member, record }) => {
    kb.text(`✅ ${member.name || member.doterraId}`, `adm_payok:${member.doterraId}:${record.period}`)
      .text('❌', `adm_payno:${member.doterraId}:${record.period}`).row();
  });
  kb.text('◀️ К оплатам', 'adm_payments');
  await ctx.reply(
    `📋 <b>Оплаты · ${escHtml(periodLabel(period))}</b>\n\n${lines.length ? lines.join('\n') : 'Гостей пока нет.'}` +
    (rows.length > 40 ? `\n… и ещё ${rows.length - 40}` : ''),
    { parse_mode: 'HTML', reply_markup: kb }
  );
}

bot.callbackQuery('adm_payments', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showPaymentsAdmin(ctx);
});

bot.callbackQuery('adm_paylist', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showPaymentList(ctx);
});

bot.callbackQuery('adm_payamount', async (ctx) => {
  adminState.set(ctx.from.id, { step: 'await_payment_amount' });
  await ctx.answerCallbackQuery();
  await ctx.reply('Введите новую месячную сумму в рублях, только число. Например: 2000', { reply_markup: new InlineKeyboard().text('◀️ Назад', 'adm_back') });
});

bot.callbackQuery('adm_paydetails', async (ctx) => {
  adminState.set(ctx.from.id, { step: 'await_payment_details' });
  await ctx.answerCallbackQuery();
  await ctx.reply('Отправьте новый текст с реквизитами и инструкцией по оплате:', { reply_markup: new InlineKeyboard().text('◀️ Назад', 'adm_back') });
});

bot.callbackQuery('adm_paygrace', async (ctx) => {
  adminState.set(ctx.from.id, { step: 'await_payment_grace' });
  await ctx.answerCallbackQuery();
  await ctx.reply('Сколько полных дней давать на оплату в начале месяца? От 0 до 31:', { reply_markup: new InlineKeyboard().text('◀️ Назад', 'adm_back') });
});

async function handlePaymentDecision(ctx, status) {
  const id = ctx.match[1];
  const period = ctx.match[2];
  const member = store.getMember(id);
  if (!member) { await ctx.answerCallbackQuery('Участник не найден.'); return; }
  const record = store.setPaymentStatus(id, period, status, ctx.from);
  if (!record) { await ctx.answerCallbackQuery('Оплата не найдена.'); return; }
  await ctx.answerCallbackQuery(status === 'paid' ? 'Оплата подтверждена' : status === 'rejected' ? 'Оплата отклонена' : 'Подтверждение отменено');
  await refreshPaymentAdminMessages(member, record);

  if (status === 'paid') {
    let text = `✅ Оплата ${formatRub(record.amountRub)} за ${periodLabel(period)} подтверждена.`;
    if (period === billingPeriod()) {
      const access = await admit(member);
      if (access.links.length) text += `\n\n🎉 Доступ открыт:\n${access.links.join('\n')}\n\nСсылка личная и действует сутки.`;
      else if (access.lack.length) text += `\n\nОплата учтена. Для доступа ещё не хватает баллов — проверь через /check.`;
      else text += `\n\nДоступ активен. Проверить состояние можно через /check.`;
    }
    try { await bot.api.sendMessage(member.userId, text); } catch {}
  } else if (status === 'rejected') {
    try {
      await bot.api.sendMessage(member.userId, `❌ Оплата за ${periodLabel(period)} не подтверждена. Проверь перевод и нажми «Я оплатил(а)» ещё раз.`, {
        reply_markup: period === billingPeriod() ? paymentClaimKeyboard(period) : undefined,
      });
    } catch {}
  } else {
    try { await bot.api.sendMessage(member.userId, `↩️ Подтверждение оплаты за ${periodLabel(period)} отменено администратором.`); } catch {}
  }
  await runPaymentSweep();
}

bot.callbackQuery(/^adm_payok:(\d{6,9}):(\d{4}-\d{2})$/, (ctx) => handlePaymentDecision(ctx, 'paid'));
bot.callbackQuery(/^adm_payno:(\d{6,9}):(\d{4}-\d{2})$/, (ctx) => handlePaymentDecision(ctx, 'rejected'));
bot.callbackQuery(/^adm_paycancel:(\d{6,9}):(\d{4}-\d{2})$/, (ctx) => handlePaymentDecision(ctx, 'pending'));

bot.callbackQuery(/^pay_claim:(\d{4}-\d{2})$/, async (ctx) => {
  const member = store.findMemberByUser(ctx.from.id);
  const period = ctx.match[1];
  if (!member || store.getMemberTeam(member.doterraId) !== TEAM_GUEST) {
    await ctx.answerCallbackQuery({ text: 'Оплата для этого аккаунта не требуется.', show_alert: true });
    return;
  }
  if (period !== billingPeriod()) {
    await ctx.answerCallbackQuery({ text: 'Эта кнопка относится к прошлому месяцу. Нажми /check.', show_alert: true });
    return;
  }
  const before = store.getPayment(member.doterraId, period);
  if (paymentIsPaid(before)) {
    await ctx.answerCallbackQuery('Оплата уже подтверждена.');
    return;
  }
  if (before?.status === 'claimed' && Object.keys(before.adminMessages || {}).length) {
    await ctx.answerCallbackQuery('Заявка уже отправлена администратору.');
    return;
  }
  const record = store.claimPayment(member.doterraId, period, ctx.from.id);
  if (!record) { await ctx.answerCallbackQuery('Не удалось создать заявку.'); return; }
  await ctx.answerCallbackQuery('Передали администратору на проверку.');
  try { await ctx.editMessageText('Спасибо! Сообщение об оплате отправлено администратору — подтвердим после проверки. ✅'); } catch {}
  await notifyAdminsOfPaymentClaim(member, record);
});

let paymentSweepRunning = false;
async function runPaymentSweep(now = new Date()) {
  if (paymentSweepRunning) return;
  paymentSweepRunning = true;
  try {
    const period = billingPeriod(now);
    const settings = store.getPaymentSettings();
    for (const member of store.listMembers()) {
      if (store.getMemberTeam(member.doterraId) !== TEAM_GUEST) continue;
      const record = store.ensurePayment(member.doterraId, period, now);
      if (!record || paymentIsPaid(record)) continue;
      const inside = TIERS.filter((tier) => member.tiers?.[tier.key] === 'in');
      if (!inside.length) continue;

      if (!paymentDeadlinePassed(record, now)) {
        if (record.status !== 'claimed' && !record.remindedAt) {
          try {
            await bot.api.sendMessage(
              member.userId,
              `💳 Напоминание об оплате\n\nЗа ${periodLabel(period)} нужно оплатить ${formatRub(record.amountRub)} до ${fmtDate(record.dueAt)}.\n\n${settings.payDetails}`,
              { reply_markup: paymentClaimKeyboard(period) }
            );
            store.markPaymentReminder(member.doterraId, period, now);
          } catch {}
        }
        continue;
      }

      let removed = 0;
      for (const tier of inside) {
        const result = await banFromTier(member.userId, tier);
        if (result.banned) {
          store.setTierState(member.doterraId, tier.key, null);
          removed++;
        }
        await sleep(300);
      }
      if (removed && !record.removedAt) {
        store.markPaymentRemoved(member.doterraId, period, now);
        try {
          await bot.api.sendMessage(
            member.userId,
            `😔 Доступ приостановлен: оплата ${formatRub(record.amountRub)} за ${periodLabel(period)} не подтверждена.\n\nПосле оплаты нажми кнопку — когда администратор подтвердит перевод и баллов будет достаточно, я снова выдам ссылку.`,
            { reply_markup: paymentClaimKeyboard(period) }
          );
        } catch {}
        await tellAdmins(
          `🗑 За неоплату удалён участник команды «Гость»: ${mention(member.userId, member.name)} · ID <code>${member.doterraId}</code> · ${periodLabel(period)}.`
        );
      }
    }
  } catch (e) {
    console.error('payment sweep:', e.message);
  } finally {
    paymentSweepRunning = false;
  }
}

async function notifyAdminsOfPush(summary) {
  const kb = new InlineKeyboard();
  TIERS.forEach((t) => kb.text(`Проверить: ${t.name} (от ${t.threshold})`, `adm_pushtier:${summary.uploadId}:${t.key}`).row());
  kb.text(`📂 Управлять выгрузками (${summary?.uploads || 1})`, 'adm_uploads').row();
  kb.text('🔕 Позже', 'adm_dismiss_push');
  const mode = summary?.mode === 'closed' ? '🟢 Закрытый месяц · удаление и приглашение' : '🔴 Текущий месяц · только приглашение';
  const text =
    `📲 <b>Пришли данные из расширения</b>\n` +
    `${mode}\n` +
    (summary?.month ? `📅 ${escHtml(summary.month)}\n` : '') +
    `👥 Всего: ${summary?.total ?? '?'} · Анджелика: ${summary?.angelika ?? '?'} · Гость: ${summary?.guests ?? '?'}\n` +
    `⭐️ PV≥50: ${summary?.ge50 ?? '?'} · выгрузок в наборе: ${summary?.batchUploads ?? 1}\n` +
    (summary?.dropped?.length ? `♻️ Лимит 5: удалена самая старая выгрузка.\n` : '') +
    `\n` +
    (summary?.mode === 'closed' ? `Проверить чат на удаление и приглашение:` : `Проверить, кого пригласить:`);
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
    return ctx.reply(
      '📭 Данных пока нет.\n\nОткрой в doTERRA «Команда → Структура» и нажми месяц в расширении — файл сам прилетит сюда. Можно и просто прислать мне CSV сюда в чат.',
      { reply_markup: mainMenu() }
    );
  }
  const kb = new InlineKeyboard();
  TIERS.forEach((t) => kb.text(`${t.name} (от ${t.threshold})`, `adm_pushtier:${box.anchorId}:${t.key}`).row());
  kb.text(`📂 Управлять выгрузками (${box.uploads})`, 'adm_uploads').row();
  kb.text('◀️ Назад', 'adm_back');
  const when = box.receivedAt ? new Date(box.receivedAt).toLocaleString('ru-RU') : '—';
  const mode = box.mode === 'closed'
    ? '🟢 Закрытый месяц: можно удалять и приглашать'
    : '🔴 Текущий месяц: только приглашение, без удаления';
  const angelika = Object.values(box.teams || {}).filter((team) => team !== TEAM_GUEST).length;
  const guests = Object.values(box.teams || {}).filter((team) => team === TEAM_GUEST).length;
  await ctx.reply(
    `🔄 <b>Обновление списка участников</b>\n` +
    `${mode}\n` +
    `📅 Данные${box.month ? ' за ' + escHtml(box.month) : ''} · получены ${when}\n` +
    `👥 В выгрузке: ${box.total} чел. · Анджелика: ${angelika} · Гость: ${guests}\n` +
    `⭐️ PV≥50: ${box.ge50 ?? '—'} · выгрузок в наборе: ${box.batchUploads.length} · всего сохранено: ${box.uploads}/5\n\n` +
    `Какой чат пересчитываем? ${box.mode === 'closed' ? 'Покажу, кого удалить и кого пригласить' : 'Покажу только, кого пригласить'}:`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
}

bot.callbackQuery('adm_inbox', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showInbox(ctx);
});

// Проверить выбранный чат по конкретному набору выгрузок.
bot.callbackQuery(/^adm_pushtier:([^:]+):(\w+)$/, async (ctx) => {
  const tier = tierByKey(ctx.match[2]);
  await ctx.answerCallbackQuery();
  if (!tier) return ctx.reply('Чат не найден.', { reply_markup: mainMenu() });
  if (!store.startImportFromInbox(ctx.from.id, tier.key, ctx.match[1])) {
    return ctx.reply('Пока нет данных из расширения. Нажми «Экспорт» в расширении doTERRA — они прилетят сюда сами.', { reply_markup: mainMenu() });
  }
  await calcAndShow(ctx);
});

function uploadModeLabel(mode) { return mode === 'closed' ? '🟢 закрытый' : '🔴 текущий'; }

async function showUploads(ctx) {
  const uploads = store.listInboxUploads();
  if (!uploads.length) return ctx.reply('📭 Сохранённых выгрузок нет.', { reply_markup: mainMenu() });
  const lines = uploads.map((u, i) => {
    const when = new Date(u.receivedAt).toLocaleString('ru-RU');
    const label = u.cabinet || u.name || 'без названия';
    return `${i + 1}. ${uploadModeLabel(u.mode)} · ${escHtml(u.month || 'месяц не указан')}\n   👥 ${teamLabel(u.team)} · ${escHtml(label)} · ${u.count} чел. · ${when}`;
  });
  const kb = new InlineKeyboard();
  uploads.forEach((u, i) => {
    kb.text(`${u.mode === 'closed' ? '🟢→🔴' : '🔴→🟢'} №${i + 1}`, `adm_uptoggle:${u.id}`)
      .text(`🗑 №${i + 1}`, `adm_updelask:${u.id}`).row();
  });
  kb.text('◀️ К обновлению', 'adm_inbox');
  await ctx.reply(
    `📂 <b>Выгрузки — ${uploads.length}/5</b>\n\n${lines.join('\n\n')}\n\n` +
    `Новая шестая выгрузка автоматически удалит самую старую. Кнопка со стрелкой переключает режим файла.`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
}

bot.callbackQuery('adm_uploads', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showUploads(ctx);
});

bot.callbackQuery(/^adm_uptoggle:([^:]+)$/, async (ctx) => {
  const changed = store.toggleInboxUploadMode(ctx.match[1]);
  await ctx.answerCallbackQuery(changed ? 'Режим изменён' : 'Выгрузка не найдена');
  await showUploads(ctx);
});

bot.callbackQuery(/^adm_updelask:([^:]+)$/, async (ctx) => {
  const upload = store.listInboxUploads().find((u) => u.id === ctx.match[1]);
  await ctx.answerCallbackQuery();
  if (!upload) return ctx.reply('Выгрузка уже удалена.');
  const label = upload.cabinet || upload.name;
  await ctx.reply(
    `Удалить выгрузку «${escHtml(label)}» (${escHtml(upload.month || 'без месяца')})? Итоговый список будет пересчитан по оставшимся файлам.`,
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('🗑 Да, удалить', `adm_updel:${upload.id}`).row().text('❌ Отмена', 'adm_uploads'),
    }
  );
});

bot.callbackQuery(/^adm_updel:([^:]+)$/, async (ctx) => {
  const removed = store.removeInboxUpload(ctx.match[1]);
  await ctx.answerCallbackQuery(removed ? 'Удалено' : 'Уже удалено');
  await showUploads(ctx);
});

bot.callbackQuery('adm_dismiss_push', async (ctx) => {
  await ctx.answerCallbackQuery('Ок! Данные сохранены. Открой /admin, когда будешь готов проверить.');
});

bot.callbackQuery('adm_list', async (ctx) => {
  const members = store.listMembers();
  await ctx.answerCallbackQuery();
  if (!members.length) {
    return ctx.reply('👥 Участников пока нет.\n\nЛюди появятся здесь, когда напишут боту свой doTERRA ID.', { reply_markup: mainMenu() });
  }
  // Группируем по состоянию: плоский список с бейджами читался хуже — глазами
  // приходилось выискивать, кто из них вообще не дошёл до чата.
  const groups = { in: [], invited: [], waiting: [] };
  for (const m of members) {
    const inT = TIERS.filter((t) => m.tiers?.[t.key] === 'in');
    const invT = TIERS.filter((t) => m.tiers?.[t.key] === 'invited');
    const where = inT.length ? ' · ' + inT.map((t) => '№' + t.key).join(',') : invT.length ? ' · ' + invT.map((t) => '№' + t.key).join(',') : '';
    const team = store.getMemberTeam(m.doterraId);
    const payment = team === TEAM_GUEST ? store.getPayment(m.doterraId, billingPeriod()) : null;
    const payMark = team === TEAM_GUEST ? (paymentIsPaid(payment) ? ' · оплата ✅' : payment?.status === 'claimed' ? ' · оплата 🙋' : ' · оплата ⏳') : '';
    const row = `${m.name || '—'} · ${m.doterraId} · ${fmtPv(store.getPoints(m.doterraId))} б. · ${teamLabel(team)}${payMark}${where}`;
    (inT.length ? groups.in : invT.length ? groups.invited : groups.waiting).push(row);
  }

  const block = (icon, title, rows) =>
    rows.length ? `\n${icon} <b>${title} — ${rows.length}</b>\n` + rows.map((r, i) => `${i + 1}. ${escHtml(r)}`).join('\n') + '\n' : '';
  let text =
    `👥 <b>Участники — ${members.length}</b>\n` +
    block('🟢', 'В чатах', groups.in) +
    block('🟡', 'Приглашены, но не вошли', groups.invited) +
    block('⚪️', 'Ждут выполнения условий', groups.waiting);
  if (groups.invited.length) text += `\n💡 Не вошли — ссылка живёт сутки. «Обновить список участников» выдаст им новую.`;
  if (text.length > 3800) text = text.slice(0, 3800) + '\n…';
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: mainMenu() });
});

const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : null);

// «Статус» — заодно и диагностика: видно, живо ли хранилище между деплоями,
// насколько свежие баллы и не лежат ли непринятые данные из расширения.
function statusText(members, perTier) {
  const info = store.getStorageInfo();
  const points = Object.keys(store.getData().points || {}).length;
  const when = fmtWhen(store.getPointsUpdatedAt());
  const box = store.getInbox();
  const period = billingPeriod();
  const guests = members.filter((member) => store.getMemberTeam(member.doterraId) === TEAM_GUEST);
  const paidGuests = guests.filter((member) => paymentIsPaid(store.getPayment(member.doterraId, period))).length;
  const claimedPayments = guests.filter((member) => store.getPayment(member.doterraId, period)?.status === 'claimed').length;

  const pointsLine = points
    ? `⭐️ Баллы в базе: ${points} чел.${when ? ` · обновлены ${when}` : ''}`
    : `⭐️ Баллы в базе: пусто — ни одно обновление ещё не применено`;
  const inboxLine = box?.total
    ? `📥 Последний набор: ${box.total} чел.${box.month ? ` за ${box.month}` : ''} · ${box.mode === 'closed' ? '🟢 закрытый' : '🔴 текущий'} · выгрузок ${box.uploads}/5 · получены ${fmtWhen(box.receivedAt) || '—'}\n   Нажми «Обновить список участников», чтобы проверить или применить.`
    : `📥 Выгрузки: ничего не пришло`;
  const postgresLine = info.postgresEnabled
    ? `🐘 PostgreSQL: ${info.postgresConnected ? `подключена${info.postgresLastSyncedAt ? ` · синхронизация ${fmtWhen(info.postgresLastSyncedAt)}` : ''}` : 'ошибка подключения — используется локальная копия'}`
    : '🐘 PostgreSQL: не подключена';

  return (
    `ℹ️ Статус\n\n` +
    `👥 Зарегистрировано: ${members.length} · Гостей: ${guests.length}\n${perTier || '(чаты не настроены)'}\n` +
    `💳 ${periodLabel(period)}: оплачено ${paidGuests} · ждут подтверждения ${claimedPayments}\n\n` +
    `${pointsLine}\n${inboxLine}\n\n` +
    `💾 Хранилище: ${info.directory}\n` +
    `   резервных копий: ${info.backups}${info.lastBackupAt ? ` · последняя ${fmtWhen(info.lastBackupAt)}` : ''}\n` +
    postgresLine
  );
}

bot.callbackQuery('adm_status', async (ctx) => {
  const members = store.listMembers();
  await ctx.answerCallbackQuery();
  const perTier = TIERS.map((t) => `• ${t.name} (от ${t.threshold}): ${members.filter((m) => m.tiers?.[t.key] === 'in').length} в чате`).join('\n');
  await ctx.reply(statusText(members, perTier));
});

bot.callbackQuery('adm_cancel', async (ctx) => {
  store.clearImport();
  await ctx.answerCallbackQuery('Отменено');
  await ctx.reply('Отменено.', { reply_markup: mainMenu() });
});

// Полного списка участников Telegram ботам не отдаёт. Мы можем удалить только
// тех незарегистрированных, чей user_id бот уже видел в сообщении/вступлении.
// Остальных показываем администратору приблизительным количеством «молчунов».
async function registrationAudit(tier) {
  if (!tier?.id) return { total: null, registered: [], knownUnregistered: [], unknown: null, admins: [] };
  // Не вызываем getChatMember для каждого зарегистрированного: в большом чате
  // это тысячи запросов. Состояние поддерживается событиями входа/выхода, а
  // итоговое число неизвестных всё равно является приблизительным.
  const registered = store.listMembers().filter((m) => m.tiers?.[tier.key] === 'in');
  const admins = [];
  const adminIds = new Set();
  try {
    for (const a of await bot.api.getChatAdministrators(tier.id)) {
      const u = a.user;
      admins.push(u);
      adminIds.add(u.id);
    }
  } catch {}

  const knownUnregistered = [];
  const seenIds = new Set();
  for (const s of store.listSeen()) {
    if (!s.tiers?.[tier.key] || seenIds.has(s.userId)) continue;
    seenIds.add(s.userId);
    if (store.findMemberByUser(s.userId) || adminIds.has(s.userId) || isAdminBase({ id: s.userId, username: s.username })) continue;
    const status = await chatMemberStatus(tier, s.userId);
    await sleep(40);
    if (!isInsideStatus(status)) continue;
    knownUnregistered.push({ userId: s.userId, name: s.name, username: s.username });
  }

  let total = null;
  try { total = await bot.api.getChatMemberCount(tier.id); } catch {}
  const accounted = new Set([
    ...registered.map((m) => m.userId),
    ...knownUnregistered.map((p) => p.userId),
    ...admins.map((u) => u.id),
  ]);
  const unknown = total == null ? null : Math.max(0, total - accounted.size);
  return { total, registered, knownUnregistered, unknown, admins };
}

function campaignStateText(campaign) {
  if (!campaign) return 'кампания ещё не запускалась';
  if (campaign.completedAt) return `завершена ${fmtWhen(campaign.completedAt)}`;
  return `сбор запущен ${fmtWhen(campaign.startedAt)} · проверка и удаление только вручную`;
}

bot.callbackQuery('adm_unreg', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!TIERS.some((t) => t.id)) return ctx.reply('Чаты ещё не настроены.', { reply_markup: mainMenu() });
  await ctx.reply('🔄 Проверяю зарегистрированных и известных участников…');
  const blocks = [];
  const kb = new InlineKeyboard();
  for (const tier of TIERS) {
    if (!tier.id) continue;
    const audit = await registrationAudit(tier);
    const campaign = store.getRegistrationCampaign(tier.key);
    blocks.push(
      `«${escHtml(tier.name)}»\n` +
      `👥 В чате: ${audit.total ?? '?'} · зарегистрировано: ${audit.registered.length}\n` +
      `👀 Известных незарегистрированных: ${audit.knownUnregistered.length}\n` +
      `🌫 Молчунов/неизвестных: ~${audit.unknown ?? '?'}\n` +
      `📅 ${campaignStateText(campaign)}`
    );
    if (!campaign || campaign.completedAt) kb.text(`📣 Начать сбор: ${tier.name}`, `adm_regstart:${tier.key}`).row();
    else kb.text(`👀 Проверить: ${tier.name}`, `adm_regcheck:${tier.key}`).row();
  }
  kb.text('◀️ Назад', 'adm_back');
  await ctx.reply(
    `👀 <b>Регистрация участников</b>\n\n${blocks.join('\n\n')}\n\n` +
    `Бот удаляет только известных ему незарегистрированных. Примерное число молчунов остаётся для ручной проверки. Автоматического удаления по сроку нет.`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
});

bot.callbackQuery(/^adm_regstart:(\w+)$/, async (ctx) => {
  const tier = tierByKey(ctx.match[1]);
  await ctx.answerCallbackQuery();
  if (!tier?.id) return ctx.reply('Чат не настроен.');
  const existing = store.getRegistrationCampaign(tier.key);
  if (existing && !existing.completedAt) return ctx.reply(`Кампания уже идёт: ${campaignStateText(existing)}.`);
  const me = await bot.api.getMe();
  const link = `https://t.me/${me.username}?start=register`;
  try {
    await bot.api.sendMessage(
      tier.id,
      `📣 <b>Регистрация участников чата</b>\n\nЗарегистрируйтесь в боте и отправьте свой doTERRA ID. Зарегистрированные участники сохранят доступ к чату. Срок завершения администратор определит вручную.`,
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().url('✅ Зарегистрироваться', link) }
    );
  } catch (e) {
    return ctx.reply(`Не удалось опубликовать объявление в «${tier.name}»: ${e.message}`);
  }
  const campaign = store.startRegistrationCampaign(tier.key);
  await ctx.reply(
    `✅ Сбор регистраций в «${tier.name}» запущен ${fmtWhen(campaign.startedAt)}.\n\nКогда решишь, открой «Кто не зарегистрирован» и вручную запусти проверку и удаление.`,
    { reply_markup: mainMenu() }
  );
});

bot.callbackQuery(/^adm_regcheck:(\w+)$/, async (ctx) => {
  const tier = tierByKey(ctx.match[1]);
  await ctx.answerCallbackQuery();
  if (!tier?.id) return ctx.reply('Чат не настроен.');
  await ctx.reply('🔄 Проверяю участников…');
  const audit = await registrationAudit(tier);
  const campaign = store.getRegistrationCampaign(tier.key);
  const ready = campaign && !campaign.completedAt;
  const list = audit.knownUnregistered.length
    ? renderPeople(audit.knownUnregistered, (p) => `• ${mention(p.userId, p.name)}${p.username ? ' @' + escHtml(p.username) : ''}`)
    : '—';
  const kb = new InlineKeyboard();
  if (ready && audit.knownUnregistered.length) kb.text(`🗑 Удалить известных (${audit.knownUnregistered.length})`, `adm_regconfirm:${tier.key}`).row();
  if (ready && !audit.knownUnregistered.length) kb.text('✅ Завершить кампанию', `adm_regfinish:${tier.key}`).row();
  kb.text('◀️ К регистрации', 'adm_unreg');
  await ctx.reply(
    `👀 <b>${escHtml(tier.name)}</b>\n\n` +
    `Зарегистрировано: ${audit.registered.length}\n` +
    `Известных незарегистрированных: ${audit.knownUnregistered.length}\n` +
    `Молчунов/неизвестных: ~${audit.unknown ?? '?'}\n` +
    `Состояние: ${campaignStateText(campaign)}\n\n` +
    `Кого бот знает и сможет удалить:\n${list}\n\n` +
    (ready ? `Удаление выполнится только после кнопки ниже.` : `Сначала запусти сбор регистраций.`),
    { parse_mode: 'HTML', reply_markup: kb }
  );
});

bot.callbackQuery(/^adm_regfinish:(\w+)$/, async (ctx) => {
  const tier = tierByKey(ctx.match[1]);
  const campaign = tier && store.getRegistrationCampaign(tier.key);
  if (!campaign || campaign.completedAt) {
    await ctx.answerCallbackQuery('Активного сбора регистраций нет.');
    return;
  }
  store.finishRegistrationCampaign(tier.key);
  await ctx.answerCallbackQuery('Кампания завершена');
  await ctx.reply('✅ Кампания регистрации завершена без автоматического удаления.', { reply_markup: mainMenu() });
});

bot.callbackQuery(/^adm_regconfirm:(\w+)$/, async (ctx) => {
  const tier = tierByKey(ctx.match[1]);
  const campaign = tier && store.getRegistrationCampaign(tier.key);
  if (!tier?.id || !campaign || campaign.completedAt) {
    await ctx.answerCallbackQuery('Активного сбора регистраций нет.');
    return;
  }
  await ctx.answerCallbackQuery();
  const audit = await registrationAudit(tier);
  await ctx.reply(`⏳ Удаляю известных незарегистрированных: ${audit.knownUnregistered.length}…`);
  let removed = 0;
  for (const person of audit.knownUnregistered) {
    if (store.findMemberByUser(person.userId)) continue; // мог зарегистрироваться прямо сейчас
    const { banned } = await banFromTier(person.userId, tier);
    if (banned) removed++;
    await sleep(300);
  }
  store.finishRegistrationCampaign(tier.key);
  await ctx.reply(
    `✅ Кампания завершена.\n\nУдалено известных незарегистрированных: ${removed}.\nНеизвестных молчунов осталось примерно: ${audit.unknown ?? '?' } — их нужно проверить вручную.`,
    { reply_markup: mainMenu() }
  );
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
// Файл, присланный админом руками, попадает в тот же инбокс, что и файл из
// канала: выбор чата больше не нужен заранее — он спрашивается после разбора.
bot.on('message:document', async (ctx) => {
  if (!isAdmin(ctx.from)) return;
  try {
    const doc = ctx.message.document;
    const { records, csvMeta } = await downloadCsvRecords(doc);
    const uploadMeta = resolveUploadMeta(ctx.message.caption, csvMeta);
    const summary = store.ingestInbox(records, {
      month: monthFromFileName(doc.file_name),
      mode: modeFromFileName(doc.file_name),
      team: uploadMeta.team,
      cabinet: uploadMeta.cabinet,
      name: doc.file_name || 'ручная выгрузка.csv',
      source: 'manual',
    });
    if (summary.dropped.length) await ctx.reply('♻️ Достигнут лимит 5 выгрузок — самая старая удалена автоматически.');
    await showInbox(ctx);
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
  const teamsMap = session.teams || {};
  const inTier = store.listMembers().filter((m) => m.tiers?.[session.tier] === 'in');
  const { toRemove: lowPv, missing } = classify(inTier, pointsMap, tier.threshold);
  const canRemove = session.mode === 'closed';
  const removeLow = canRemove ? lowPv : [];
  const removeMissing = canRemove ? missing : [];
  const reviewed = [
    ...removeLow.map((m) => ({ doterraId: m.doterraId, userId: m.userId, pv: m.pv, reason: 'low' })),
    ...removeMissing.map((m) => ({ doterraId: m.doterraId, userId: m.userId, pv: null, reason: 'missing' })),
  ];
  store.setReviewed(reviewed);

  // Кого пригласим: привязанные, кто набрал порог и ещё не в чате/не приглашён.
  const inviteCandidates = store.listMembers().filter((m) => {
    if (m.tiers?.[tier.key]) return false;
    const pv = pointsMap.get(m.doterraId);
    return !!tier.id && pv != null && pv >= tier.threshold;
  });
  const toInvite = inviteCandidates.filter((member) => {
    const team = teamsMap[member.doterraId] || store.getMemberTeam(member.doterraId);
    return team !== TEAM_GUEST || paymentIsPaid(store.getPayment(member.doterraId, billingPeriod()));
  });
  const waitingPayment = inviteCandidates.filter((member) => !toInvite.includes(member));
  const inviteHtml = toInvite.length
    ? `\n\n➕ <b>Пригласим</b> (набрали ${tier.threshold}+) — ${toInvite.length}:\n` +
      renderPeople(toInvite, (m, i) => `${i + 1}. ${mention(m.userId, m.name)}${m.username ? ' @' + escHtml(m.username) : ''} · ${pointsMap.get(m.doterraId)} б.`)
    : '';
  const invitePlain = toInvite.length
    ? `\n\n➕ Пригласим — ${toInvite.length}:\n` + renderPeople(toInvite, (m, i) => `${i + 1}. ${plainName(m)} · ${pointsMap.get(m.doterraId)} б.`)
    : '';
  const payHtml = waitingPayment.length
    ? `\n\n💳 <b>Баллов хватает, ждём оплату — ${waitingPayment.length}</b>:\n` +
      renderPeople(waitingPayment, (m, i) => `${i + 1}. ${mention(m.userId, m.name)}${m.username ? ' @' + escHtml(m.username) : ''} · ${pointsMap.get(m.doterraId)} б.`)
    : '';
  const payPlain = waitingPayment.length
    ? `\n\n💳 Баллов хватает, ждём оплату — ${waitingPayment.length}:\n` + renderPeople(waitingPayment, (m, i) => `${i + 1}. ${plainName(m)} · ${pointsMap.get(m.doterraId)} б.`)
    : '';

  const kb = applyKeyboard(reviewed.length, toInvite.length, { allowRemove: canRemove });
  const modeHead = canRemove
    ? `🟢 <b>Закрытый месяц${session.month ? ' · ' + escHtml(session.month) : ''}</b> — удаление доступно`
    : `🔴 <b>Текущий месяц${session.month ? ' · ' + escHtml(session.month) : ''}</b> — никого не удаляем`;
  const modePlain = canRemove
    ? `🟢 Закрытый месяц${session.month ? ' · ' + session.month : ''} — удаление доступно`
    : `🔴 Текущий месяц${session.month ? ' · ' + session.month : ''} — никого не удаляем`;
  const lowHtml = removeLow.length
    ? `\n\n❌ <b>Ниже ${tier.threshold} баллов — ${removeLow.length}</b>:\n` +
      renderPeople(removeLow, (m, i) => `${i + 1}. ${mention(m.userId, m.name)}${m.username ? ' @' + escHtml(m.username) : ''} · ${m.pv} б.`)
    : '';
  const lowPlain = removeLow.length
    ? `\n\n❌ Ниже ${tier.threshold} баллов — ${removeLow.length}:\n` + renderPeople(removeLow, (m, i) => `${i + 1}. ${plainName(m)} · ${m.pv} б.`)
    : '';
  const missingHtml = removeMissing.length
    ? `\n\n📭 <b>Нет ни в одной полной выгрузке — ${removeMissing.length}</b>:\n` +
      renderPeople(removeMissing, (m, i) => `${i + 1}. ${mention(m.userId, m.name)}${m.username ? ' @' + escHtml(m.username) : ''} · ID ${escHtml(m.doterraId)}`)
    : (!canRemove && missing.length ? `\n\nℹ️ Нет в промежуточном файле: ${missing.length} — они не затрагиваются.` : '');
  const missingPlain = removeMissing.length
    ? `\n\n📭 Нет ни в одной полной выгрузке — ${removeMissing.length}:\n` + renderPeople(removeMissing, (m, i) => `${i + 1}. ${plainName(m)} · ID ${m.doterraId}`)
    : (!canRemove && missing.length ? `\n\nℹ️ Нет в промежуточном файле: ${missing.length} — они не затрагиваются.` : '');
  const noChangesHtml = !reviewed.length && !toInvite.length && !waitingPayment.length ? `\n\n✅ Изменений для «${escHtml(tier.name)}» нет.` : '';
  const noChangesPlain = !reviewed.length && !toInvite.length && !waitingPayment.length ? `\n\n✅ Изменений для «${tier.name}» нет.` : '';
  const html = note + modeHead + noChangesHtml + lowHtml + missingHtml + inviteHtml + payHtml + `\n\nВыбери действие:`;
  const plain = note + modePlain + noChangesPlain + lowPlain + missingPlain + invitePlain + payPlain + `\n\nВыбери действие:`;
  try { await ctx.reply(html, { parse_mode: 'HTML', reply_markup: kb }); }
  catch (e) { console.error('adm_calc', e.message); await ctx.reply(plain.slice(0, 4000), { reply_markup: kb }); }
}
bot.callbackQuery('adm_calc', async (ctx) => { await ctx.answerCallbackQuery(); await calcAndShow(ctx); });

// Приглашаем в тир всех, кто набрал его порог и ещё не в нём/не приглашён.
async function reinviteTier(pointsMap, tier) {
  let invited = 0;
  for (const m of store.listMembers()) {
    const state = m.tiers?.[tier.key];
    if (state === 'in') continue;
    const pv = pointsMap.get(m.doterraId);
    if (pv == null || pv < tier.threshold || !tier.id) continue;
    if (store.getMemberTeam(m.doterraId) === TEAM_GUEST) {
      const payment = store.ensurePayment(m.doterraId, billingPeriod());
      if (!paymentIsPaid(payment)) continue;
    }
    // Помечен «приглашён», но в чате его нет — ссылка живёт сутки и могла
    // протухнуть. Раньше такие выпадали навсегда: массовая рассылка их
    // пропускала, и вытащить себя человек мог только сам через /check.
    // Сверяем реальный статус, чтобы не слать тем, кто уже внутри.
    if (state === 'invited') {
      if (isInsideStatus(await chatMemberStatus(tier, m.userId))) {
        store.setTierState(m.doterraId, tier.key, 'in');
        continue;
      }
    }
    const link = await inviteLink(m, tier);
    if (link) {
      store.setTierState(m.doterraId, tier.key, 'invited');
      const again = state === 'invited' ? ' (прежняя ссылка истекла — вот новая)' : '';
      try { await bot.api.sendMessage(m.userId, `🎉 Открыт доступ в «${tier.name}»${again}:\n${link}\n\nСсылка личная, работает сутки и только один раз.`); } catch {}
      invited++; await sleep(300);
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
  if (remove && session.mode !== 'closed') { await ctx.answerCallbackQuery('В текущем месяце удаление запрещено.'); return; }
  if (remove && !session.reviewed) { await ctx.answerCallbackQuery('Сначала «Посчитать».'); return ctx.reply('Сначала «Посчитать на вылет», потом удаляй.', { reply_markup: mainMenu() }); }
  if (applying) { await ctx.answerCallbackQuery('Уже выполняется, подожди…'); return; }
  applying = true; await ctx.answerCallbackQuery();
  try {
    const pointsMap = new Map(Object.entries(session.points));
    if (pointsMap.size) store.commitPoints(pointsMap, {
      replace: session.mode === 'closed',
      month: session.month || '',
      teamsMap: new Map(Object.entries(session.teams || {})),
    });
    let removed = 0, skipped = 0;
    if (remove) {
      await ctx.reply(`⏳ «${tier.name}»: удаляю до ${session.reviewed.length}…`);
      for (const r of session.reviewed) {
        const m = store.getMember(r.doterraId);
        const pv = pointsMap.has(r.doterraId) ? pointsMap.get(r.doterraId) : null;
        const stillEligible = r.reason === 'missing' ? !pointsMap.has(r.doterraId) : pv != null && pv < tier.threshold;
        if (!m || m.tiers?.[tier.key] !== 'in' || !stillEligible) { skipped++; continue; }
        const { banned } = await banFromTier(m.userId, tier);
        if (banned) {
          store.setTierState(m.doterraId, tier.key, null);
          removed++;
          const why = r.reason === 'missing'
            ? `Твоего ID нет в полной выгрузке за ${session.month || 'закрытый месяц'}.`
            : `У тебя ${pv}, а нужно ${tier.threshold} баллов.`;
          try { await bot.api.sendMessage(m.userId, `😔 Доступ в «${tier.name}» приостановлен.\n\n${why} Если данные обновятся — нажми /check.`); } catch {}
        }
        await sleep(350);
      }
    }
    const invited = invite ? await reinviteTier(pointsMap, tier) : 0;
    await runPaymentSweep();
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
  const st = adminState.get(ctx.from.id);
  if (isAdmin(ctx.from) && st?.step === 'await_payment_amount') {
    const amountRub = Number(ctx.message.text.replace(/[\s₽руб.]/gi, ''));
    if (!Number.isSafeInteger(amountRub) || amountRub < 1 || amountRub > 10_000_000) {
      await ctx.reply('Нужна сумма от 1 до 10 000 000 рублей, только число. Например: 2000');
      return;
    }
    adminState.delete(ctx.from.id);
    store.updatePaymentSettings({ amountRub });
    await ctx.reply(`✅ Месячная сумма изменена: ${formatRub(amountRub)}. Уже подтверждённые месяцы не изменятся.`, { reply_markup: mainMenu() });
    return;
  }
  if (isAdmin(ctx.from) && st?.step === 'await_payment_details') {
    const payDetails = ctx.message.text.trim();
    if (!payDetails || payDetails.length > 1200) {
      await ctx.reply('Текст должен быть от 1 до 1200 символов. Отправьте более короткий вариант.');
      return;
    }
    adminState.delete(ctx.from.id);
    store.updatePaymentSettings({ payDetails });
    await ctx.reply('✅ Реквизиты и инструкция обновлены.', { reply_markup: mainMenu() });
    return;
  }
  if (isAdmin(ctx.from) && st?.step === 'await_payment_grace') {
    const graceDays = Number(ctx.message.text.trim());
    if (!Number.isSafeInteger(graceDays) || graceDays < 0 || graceDays > 31) {
      await ctx.reply('Введите целое число дней от 0 до 31.');
      return;
    }
    adminState.delete(ctx.from.id);
    store.updatePaymentSettings({ graceDays });
    await ctx.reply(`✅ Льготный срок для новых месяцев: ${graceDays} дн. Уже созданные сроки не изменятся.`, { reply_markup: mainMenu() });
    return;
  }

  // Админ вводит ID для отвязки — этот шаг в приоритете.
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
bot.on('my_chat_member', async (ctx) => {
  const c = ctx.chat;
  const status = ctx.myChatMember?.new_chat_member?.status;
  console.log(`ℹ️ Чат: id=${c.id} type=${c.type} status=${status} title=${JSON.stringify(c.title || '')}`);
  // Канал + админка = это приёмник CSV из расширения, запоминаем сразу.
  if (c.type === 'channel' && status === 'administrator') await adoptImportChannel(c);
});

// ─────────────────────────────────────────────────────────────────────────
// Приём CSV через приватный канал — альтернатива HTTP-пушу для случая, когда у
// бота нет публичного адреса. Расширение постит файл в канал ОТДЕЛЬНЫМ ботом-
// загрузчиком, а этот бот, будучи там администратором, забирает файл и кладёт
// в тот же инбокс, что и HTTP-пуш.
//
// Почему загрузчик обязан быть другим ботом (проверено эмпирически): своего
// поста бот не получает — sendDocument в канал проходит, а channel_post на него
// не приходит. Пост другого бота приходит нормально.
const ENV_IMPORT_CHANNEL = Number(process.env.IMPORT_CHANNEL_ID) || null;
const importChannelId = () => ENV_IMPORT_CHANNEL || store.getImportChannel()?.id || null;
const seenChannelFiles = new Set(); // file_unique_id — чтобы не считать один файл дважды

async function tellAdmins(text) {
  for (const uid of adminUserIds()) {
    try { await tgRetry(() => bot.api.sendMessage(uid, text, { parse_mode: 'HTML' })); }
    catch (e) { console.error('сообщение админу', uid, e.message); }
  }
}

// Первый канал, где бот оказался админом, становится приёмником. Дальше чужие
// каналы игнорируются: иначе кто угодно подсунул бы боту свои баллы.
async function adoptImportChannel(chat) {
  const known = importChannelId();
  if (known) return known === chat.id;
  store.setImportChannel(chat.id, chat.title);
  await tellAdmins(
    `📡 Канал «${escHtml(chat.title || 'без названия')}» подключён как приёмник CSV.\n\n` +
      `Вставь этот chat_id в расширение:\n<code>${chat.id}</code>`
  );
  return true;
}

// «doterra-Июль-2026.csv» → «Июль 2026». Берём только пару «месяц + год»: к имени
// может быть приклеена метка кабинета, и без этого она утекала бы в месяц.
function monthFromFileName(name) {
  const m = String(name || '').replace(/\.csv$/i, '').match(/(\p{L}+)[\s-]+(\d{4})/u);
  return m ? `${m[1]} ${m[2]}` : '';
}

// Новое расширение помечает выгрузки в имени файла. Старые/переименованные
// файлы считаем красными: безопаснее разрешить только приглашение, чем случайно
// открыть массовое удаление. В «Управлении выгрузками» режим можно переключить.
function modeFromFileName(name) {
  const value = String(name || '').toLowerCase();
  return /(?:^|[-_])(closed|green|full)(?:[-_.]|$)/.test(value) ? 'closed' : 'current';
}

// Скачать документ и превратить в записи { id, points }. Заодно читаем
// дублирующие метки «Команда»/«Кабинет», если это файл нового расширения. Бросает понятную
// ошибку — её текст уходит админу как есть.
async function downloadCsvRecords(doc) {
  const file = await tgRetry(() => bot.api.getFile(doc.file_id));
  if (Number(file.file_size || 0) > 5_000_000) throw new Error('файл слишком большой');
  let resp = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      resp = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`, {
        signal: AbortSignal.timeout(20_000),
      });
      break;
    } catch (e) {
      lastError = e;
      const cause = e?.cause?.code || e?.cause?.message || e?.message;
      console.error(`скачивание CSV: попытка ${attempt}/4:`, cause);
      if (attempt < 4) await sleep(500 * attempt);
    }
  }
  if (!resp) {
    const cause = lastError?.cause?.code || lastError?.cause?.message || lastError?.message || 'сетевая ошибка';
    throw new Error(`не удалось скачать файл после 4 попыток (${cause})`);
  }
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const rows = parseCSV(await resp.text());
  if (!rows.length) throw new Error('файл пустой — похоже, страница не догрузилась');
  const det = detectColumns(rows);
  if (det.idIdx < 0 || det.pointsIdx < 0) throw new Error('не нашёл колонки ID и PV — это файл от расширения?');
  const records = extractRecords(rows, det.idIdx, det.pointsIdx);
  if (!records.length) throw new Error('в файле только заголовок, ни одной строки');
  return { records, csvMeta: parseUploadCsvMeta(rows) };
}

bot.on('channel_post', async (ctx) => {
  if (!(await adoptImportChannel(ctx.chat))) return;
  const post = ctx.channelPost;
  // reply_to_message — запасной путь: если файл почему-то оказался постом этого
  // же бота, достаточно ответить на него любым текстом.
  const doc = post.document || post.reply_to_message?.document;
  if (!doc || seenChannelFiles.has(doc.file_unique_id)) return;
  try {
    const { records, csvMeta } = await downloadCsvRecords(doc);
    seenChannelFiles.add(doc.file_unique_id);
    const uploadMeta = resolveUploadMeta(post.caption, csvMeta);
    const summary = store.ingestInbox(records, {
      month: monthFromFileName(doc.file_name),
      mode: modeFromFileName(doc.file_name),
      team: uploadMeta.team,
      cabinet: uploadMeta.cabinet,
      name: doc.file_name || 'выгрузка из канала.csv',
      source: 'channel',
    });
    await notifyAdminsOfPush(summary);
  } catch (e) {
    console.error('канал:', e.message);
    await tellAdmins(`⚠️ Файл из канала не принят: ${escHtml(e.message)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// HTTP-приём данных из расширения (авто-пуш). Поднимается только если задан
// порт (PORT/INGEST_PORT) и секрет (INGEST_SECRET). Иначе — тихо выключен,
// бот работает как раньше (приём CSV файлом остаётся).
startIngestServer({
  port: Number(process.env.PORT || process.env.INGEST_PORT || 0),
  secret: process.env.INGEST_SECRET || '',
  onPush: async (rows, meta) => {
    const summary = store.ingestInbox(rows, { ...meta, source: 'http', name: meta.name || 'HTTP-выгрузка.csv' });
    await notifyAdminsOfPush(summary);
    return summary;
  },
});

bot.catch((err) => console.error('bot:', err.error?.message || err.message));
let paymentSweepTimer = null;
bot.start({
  // channel_post — файлы из расширения через канал-приёмник.
  allowed_updates: ['message', 'callback_query', 'chat_member', 'my_chat_member', 'channel_post'],
  onStart: () => {
    console.log('✓ Бот запущен (участники + админка в одном)');
    setTimeout(() => runPaymentSweep(), 2_000);
    paymentSweepTimer = setInterval(() => runPaymentSweep(), 30 * 60 * 1000);
  },
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Остановка (${signal}): сохраняю данные…`);
  if (paymentSweepTimer) clearInterval(paymentSweepTimer);
  try { await bot.stop(); } catch {}
  try { await store.closeStorage(); } catch (error) { console.error('storage close:', error.message); }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
