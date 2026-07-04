import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import { parseCSV, detectColumns, extractRecords } from './csv.js';
import { classify } from './logic.js';
import * as store from './store.js';

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
  !!u && (ADMIN_IDS.has(u.id) || (u.username && ADMIN_USERNAMES.has(u.username.toLowerCase())) || store.getAutoAdmins().includes(u.id));
const fmtPv = (pv) => (pv == null ? '—' : pv);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      `ID *${member.doterraId}* принят ✅\nБаллы появятся после ближайшего обновления базы — я напишу, как откроется доступ.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  let msg = '';
  if (r.links.length) msg += `✅ Доступ открыт! Заходи (ссылки одноразовые, действуют сутки):\n\n${r.links.join('\n')}\n\n`;
  if (r.inNow.length) msg += `Ты уже в: ${r.inNow.join(', ')}.\n`;
  if (r.soon.length) msg += `Доступ положен, но ${r.soon.join(', ')} ещё настраивается — нажми /check позже.\n`;
  if (r.lack.length) msg += `Пока не хватает баллов (у тебя ${r.pv}): ${r.lack.join('; ')}.\n`;
  await ctx.reply((msg || `Баллов: ${r.pv}. Доступных чатов сейчас нет.`).trim());
}

// ─────────────────────────────────────────────────────────────────────────
//  ОБЩИЕ КОМАНДЫ (роль определяется по isAdmin)
// ─────────────────────────────────────────────────────────────────────────
function mainMenu() {
  return new InlineKeyboard()
    .text('📥 Обновить подписчиков', 'adm_update').row()
    .text('📋 Список участников', 'adm_list').row()
    .text('🔗 Отвязать участника', 'adm_unbind_start').row()
    .text('ℹ️ Статус', 'adm_status');
}
const showAdminPanel = (ctx) =>
  ctx.reply('Админ-панель doTERRA. Выбери действие ниже.\nЕщё команды — /help.', { reply_markup: mainMenu() });

// /start — админ сразу попадает в панель, остальные регистрируются.
bot.command('start', async (ctx) => {
  if (isAdmin(ctx.from)) return showAdminPanel(ctx);
  const existing = store.findMemberByUser(ctx.from.id);
  if (existing) {
    const pv = store.getPoints(existing.doterraId);
    await ctx.reply(`Ты уже зарегистрирован.\nID: ${existing.doterraId}\nБаллы: ${fmtPv(pv)}\n\nНажми /check для проверки доступа, или пришли другой ID, если ошибся.`);
    return;
  }
  store.setFlow(ctx.from.id, 'awaiting_id');
  await ctx.reply(`Привет! 👋\nЧтобы попасть в чат «Бережное врачевание», напиши тут свой *ID участника doTERRA* — это номер из кабинета (обычно 7–8 цифр).\nНапример: 18170008`, { parse_mode: 'Markdown' });
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
  await ctx.reply('Команда доступна только администраторам.');
});

// /check — проверка своего доступа (для участников).
bot.command('check', async (ctx) => {
  const member = store.findMemberByUser(ctx.from.id);
  if (!member) { store.setFlow(ctx.from.id, 'awaiting_id'); await ctx.reply('Ты ещё не зарегистрирован. Пришли свой ID doTERRA (7–8 цифр).'); return; }
  await evaluateAndReply(ctx, member);
});

bot.command('whoami', (ctx) => ctx.reply(`Твой user_id: ${ctx.from.id}`));

// Узнать ID чата: напиши /id прямо в нужном чате (бот должен быть там участником/
// админом). Пригодится, чтобы вписать TIERn_ID в .env.
bot.command(['id', 'chatid'], (ctx) =>
  ctx.reply(`chat id: \`${ctx.chat.id}\`\nтип: ${ctx.chat.type}${ctx.chat.title ? `\n${ctx.chat.title}` : ''}`, { parse_mode: 'Markdown' })
);

bot.command('help', (ctx) => {
  if (isAdmin(ctx.from)) {
    return ctx.reply('Команды админа:\n• /admin — открыть панель\n• /rebind <ID> <user_id> — перепривязать doTERRA ID на другой Telegram-аккаунт\n• /unbind <ID> — снять привязку ID (и выгнать из чатов)\n• /whoami — твой user_id\n\nОбновление подписчиков и списки — через меню /admin.');
  }
  return ctx.reply('Напиши /start, чтобы зарегистрироваться, или /check — проверить доступ. Прислать нужно свой doTERRA ID (7–8 цифр).');
});

// ─────────────────────────────────────────────────────────────────────────
//  АДМИНСКИЕ КОМАНДЫ
// ─────────────────────────────────────────────────────────────────────────
bot.command('rebind', async (ctx) => {
  if (!isAdmin(ctx.from)) return ctx.reply('Команда доступна только администраторам.');
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
  if (!isAdmin(ctx.from)) return ctx.reply('Команда доступна только администраторам.');
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

// «Обновить подписчиков» → выбор чата (тира)
bot.callbackQuery('adm_update', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!TIERS.length) return ctx.reply('Чаты не настроены (TIER1_NAME… в .env).', { reply_markup: mainMenu() });
  const kb = new InlineKeyboard();
  TIERS.forEach((t) => kb.text(`${t.name} (от ${t.threshold})`, `adm_tier:${t.key}`).row());
  kb.text('❌ Отмена', 'adm_cancel');
  await ctx.reply('Какой чат обновляем? У каждого свой порог баллов.', { reply_markup: kb });
});

bot.callbackQuery(/^adm_tier:(\w+)$/, async (ctx) => {
  const tier = tierByKey(ctx.match[1]);
  await ctx.answerCallbackQuery();
  if (!tier) return ctx.reply('Чат не найден.', { reply_markup: mainMenu() });
  store.startImport(ctx.from.id, tier.key);
  await ctx.reply(
    `Обновляем «${tier.name}» (порог ${tier.threshold}).\n📥 Пришли CSV из расширения. Если кабинета два — оба по очереди, потом «Посчитать».`,
    { reply_markup: new InlineKeyboard().text('✅ Посчитать на вылет', 'adm_calc').text('❌ Отмена', 'adm_cancel') }
  );
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
  const head = `Участники (${members.length}) — 🟢N в чате N, 🟡N приглашён, ⚪️ ждёт:\n`;
  let body = lines.join('\n');
  if ((head + body).length > 3800) body = lines.slice(0, 60).join('\n') + `\n… и ещё ${members.length - 60}`;
  await ctx.reply(head + body);
});

bot.callbackQuery('adm_status', async (ctx) => {
  const members = store.listMembers();
  await ctx.answerCallbackQuery();
  const perTier = TIERS.map((t) => `• ${t.name} (от ${t.threshold}): ${members.filter((m) => m.tiers?.[t.key] === 'in').length} в чате`).join('\n');
  await ctx.reply(
    `Зарегистрировано: ${members.length}\n${perTier || '(чаты не настроены)'}\n` +
      `Снимок баллов: ${Object.keys(store.getData().points).length} записей.`
  );
});

bot.callbackQuery('adm_cancel', async (ctx) => {
  store.clearImport();
  await ctx.answerCallbackQuery('Отменено');
  await ctx.reply('Отменено.', { reply_markup: mainMenu() });
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
    await ctx.reply(`«${tier?.name}»: файл принят, ${added} строк (файлов: ${sess.files.length}).${warn}`, {
      reply_markup: new InlineKeyboard().text('✅ Посчитать на вылет', 'adm_calc').text('❌ Отмена', 'adm_cancel'),
    });
  } catch (e) { await ctx.reply('Ошибка чтения файла: ' + e.message); }
});

bot.callbackQuery('adm_calc', async (ctx) => {
  const session = store.getImport();
  await ctx.answerCallbackQuery();
  const tier = tierByKey(session?.tier);
  if (!session || !session.files.length || !tier) return ctx.reply('Сначала выбери чат и пришли CSV.');
  const pointsMap = new Map(Object.entries(session.points));
  const inTier = store.listMembers().filter((m) => m.tiers?.[session.tier] === 'in');
  const { toRemove, missing } = classify(inTier, pointsMap, tier.threshold);
  store.setReviewed(toRemove.map((m) => ({ doterraId: m.doterraId, userId: m.userId, pv: m.pv })));

  if (!toRemove.length) {
    await ctx.reply(
      `«${tier.name}»: удалять некого — все набрали ${tier.threshold}+.` + (missing.length ? `\n(${missing.length} без данных — не тронуты.)` : ''),
      { reply_markup: new InlineKeyboard().text('✅ Обновить баллы (без удаления)', 'adm_commit').text('❌ Отмена', 'adm_cancel') }
    );
    return;
  }
  const list = toRemove.map((m, i) => `${i + 1}. ${m.name || '—'} · ${m.doterraId} · ${m.pv}`).join('\n');
  const text = `❌ ИЗ «${tier.name}» НА ВЫЛЕТ (PV < ${tier.threshold}) — ${toRemove.length}:\n${list}` + (missing.length ? `\n\n⚠️ Без данных (не тронем): ${missing.length}` : '') + `\n\nПодтвердить удаление?`;
  await ctx.reply(text.length > 3800 ? text.slice(0, 3800) + '\n… (длинный список)' : text, {
    reply_markup: new InlineKeyboard().text(`🗑 Удалить ${toRemove.length}`, 'adm_confirm').text('❌ Отмена', 'adm_cancel'),
  });
});

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
        try { await bot.api.sendMessage(m.userId, `Ты набрал баллы — доступ в «${tier.name}»:\n${link}`); } catch {}
        invited++; await sleep(300);
      }
    }
  }
  return invited;
}

bot.callbackQuery('adm_commit', async (ctx) => {
  const session = store.getImport();
  const tier = tierByKey(session?.tier);
  if (!session || !session.files.length || !tier) { await ctx.answerCallbackQuery('Нет данных.'); return ctx.reply('Нет активного импорта.', { reply_markup: mainMenu() }); }
  if (applying) { await ctx.answerCallbackQuery('Уже выполняется…'); return; }
  applying = true; await ctx.answerCallbackQuery();
  try {
    const pointsMap = new Map(Object.entries(session.points));
    if (pointsMap.size) store.commitPoints(pointsMap);
    const invited = await reinviteTier(pointsMap, tier);
    store.clearImport();
    await ctx.reply(`«${tier.name}»: баллы обновлены, никого не удалял.\n✅ Приглашено (набрали порог): ${invited}`, { reply_markup: mainMenu() });
  } catch (e) { console.error('adm_commit', e.message); await ctx.reply('Ошибка: ' + e.message, { reply_markup: mainMenu() }); }
  finally { applying = false; }
});

bot.callbackQuery('adm_confirm', async (ctx) => {
  const session = store.getImport();
  const tier = tierByKey(session?.tier);
  if (!session || !session.reviewed || !tier) { await ctx.answerCallbackQuery('Сначала «Посчитать».'); return ctx.reply('Сначала «Посчитать», потом подтверждай.', { reply_markup: mainMenu() }); }
  if (applying) { await ctx.answerCallbackQuery('Уже выполняется, подожди…'); return; }
  applying = true; await ctx.answerCallbackQuery();
  await ctx.reply(`⏳ «${tier.name}»: применяю удаление до ${session.reviewed.length}…`);
  try {
    const pointsMap = new Map(Object.entries(session.points));
    if (pointsMap.size) store.commitPoints(pointsMap);
    let removed = 0, skipped = 0;
    for (const r of session.reviewed) {
      const m = store.getMember(r.doterraId);
      const pv = pointsMap.has(r.doterraId) ? pointsMap.get(r.doterraId) : null;
      if (!m || m.tiers?.[tier.key] !== 'in' || pv == null || !(pv < tier.threshold)) { skipped++; continue; }
      const { banned } = await banFromTier(m.userId, tier);
      if (banned) {
        store.setTierState(m.doterraId, tier.key, null);
        removed++;
        try { await bot.api.sendMessage(m.userId, `Доступ в «${tier.name}» закрыт: ${pv} балл(ов), нужно ${tier.threshold}. Набери баллы и нажми /check.`); } catch {}
      }
      await sleep(350);
    }
    const invited = await reinviteTier(pointsMap, tier);
    store.clearImport();
    let msg = `Готово по «${tier.name}».\n🗑 Удалено: ${removed}\n✅ Приглашено: ${invited}`;
    if (skipped) msg += `\nℹ️ Пропущено (вышли/восстановились): ${skipped}`;
    await ctx.reply(msg, { reply_markup: mainMenu() });
  } catch (e) { console.error('adm_confirm', e.message); await ctx.reply('Ошибка: ' + e.message, { reply_markup: mainMenu() }); }
  finally { applying = false; }
});

// ─────────────────────────────────────────────────────────────────────────
//  ТЕКСТ И СОБЫТИЯ ЧАТА
// ─────────────────────────────────────────────────────────────────────────
bot.on('message:text', async (ctx) => {
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
      await ctx.reply(`⛔️ ID *${text}* уже привязан к другому Telegram-аккаунту.\nЕсли это ваш ID — напишите администратору.`, { parse_mode: 'Markdown' });
      return;
    }
    const member = store.registerMember(text, ctx.from);
    await evaluateAndReply(ctx, member);
    return;
  }
  const flow = store.getFlow(ctx.from.id);
  if (flow?.step === 'awaiting_id') { await ctx.reply('Пришли только цифры ID (обычно 7–8 цифр), например 18170008.'); return; }
  const member = store.findMemberByUser(ctx.from.id);
  await ctx.reply(member ? 'Пришли ID (7–8 цифр), если хочешь исправить, или нажми /check.' : 'Напиши /start, чтобы зарегистрироваться.');
});

// Фактический вход/выход в чате тира → источник правды членства.
bot.on('chat_member', (ctx) => {
  const t = tierByChat(ctx.chat?.id);
  if (!t) return;
  const uid = ctx.chatMember.new_chat_member?.user?.id;
  const status = ctx.chatMember.new_chat_member?.status;
  const member = uid && store.findMemberByUser(uid);
  if (!member) return;
  const inside = status === 'member' || status === 'administrator' || status === 'creator';
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
bot.catch((err) => console.error('bot:', err.error?.message || err.message));
bot.start({
  allowed_updates: ['message', 'callback_query', 'chat_member', 'my_chat_member'],
  onStart: () => console.log('✓ Бот запущен (участники + админка в одном)'),
});
