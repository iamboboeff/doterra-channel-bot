// Файловое хранилище в store.json.
// Каждая операция читает свежую версию файла и сразу пишет обратно — так бот
// участников и админ-бот могут работать как ДВА процесса, деля один store.json
// на общем диске (bothost: STORE_DIR=/app/shared при «Общем хранилище»).
//
// Членство участника хранится ПО КАЖДОМУ ЧАТУ (тиру) отдельно:
//   member.tiers = { "1": "in" | "invited", "2": "in" | "invited", ... }
//   "invited" — выдали ссылку, ждём входа; "in" — реально вступил.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DIR = process.env.STORE_DIR || dirname(fileURLToPath(import.meta.url));
const FILE = resolve(DIR, 'store.json');
const TMP = resolve(DIR, 'store.json.tmp');

const EMPTY = {
  members: {}, // doterraId -> { doterraId, userId, username, name, registeredAt, tiers:{} }
  points: {}, // doterraId -> PV
  flows: {}, // userId -> { step }
  import: null, // { tier, points:{id:pv}, files:[], by, reviewed:[] }
  inbox: null, // авто-пуш из расширения: { points:{id:pv}, month, cabinets:[], receivedAt, total, ge50 }
  admins: [], // userId[] — авто-админы и админы, добавленные командой /addadmin
  adminUsernames: [], // username[] — админы, добавленные командой /addadmin
  adminPhones: [], // phone[] — ожидают подтверждения контактом в Telegram
  seen: {}, // userId -> { userId, name, username, tiers:{tierKey:lastISO} } — кого бот видел в чатах
};

function db() {
  if (!existsSync(FILE)) return structuredClone(EMPTY);
  try {
    return { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(FILE, 'utf8')) };
  } catch {
    return structuredClone(EMPTY);
  }
}

function persist(data) {
  try { mkdirSync(DIR, { recursive: true }); } catch {}
  writeFileSync(TMP, JSON.stringify(data, null, 2));
  renameSync(TMP, FILE);
}

export function getData() { return db(); }
export function save() {}

// ── «Замеченные» в чатах ────────────────────────────────────────────────
// Кого бот видел писавшим/входившим в чате тира — чтобы находить среди них
// незарегистрированных (у кого нет привязки doTERRA ID). Ботов не пишем.
export function recordSeen(user, tierKey) {
  if (!user?.id || user.is_bot) return;
  const data = db();
  if (!data.seen) data.seen = {};
  const cur = data.seen[user.id] || { userId: user.id, tiers: {} };
  cur.name = [user.first_name, user.last_name].filter(Boolean).join(' ') || cur.name || '';
  cur.username = user.username || cur.username || null;
  if (!cur.tiers) cur.tiers = {};
  cur.tiers[tierKey] = new Date().toISOString();
  data.seen[user.id] = cur;
  persist(data);
}

export function listSeen() { return Object.values(db().seen || {}); }

// ── администраторы из хранилища ───────────────────────────────────────────
// `admins` сохраняет обратную совместимость со старым авто-фолбэком, а также
// содержит ID, добавленные работающим ботом через /addadmin.
const cleanUsername = (value) => String(value ?? '').trim().replace(/^@/, '').toLowerCase();
const cleanPhone = (value) => {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) digits = '7' + digits.slice(1);
  return digits;
};

export function getAutoAdmins() {
  return (db().admins || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
}

export function addAutoAdmin(userId) {
  const data = db();
  if (!data.admins) data.admins = [];
  const id = Number(userId);
  if (!data.admins.some((x) => Number(x) === id)) { data.admins.push(id); persist(data); }
  return data.admins;
}

export function addAdminId(userId) {
  const id = Number(userId);
  const before = getAutoAdmins().includes(id);
  addAutoAdmin(id);
  return { added: !before, value: id };
}

export function addAdminUsername(username) {
  const data = db();
  const value = cleanUsername(username);
  if (!data.adminUsernames) data.adminUsernames = [];
  const added = !!value && !data.adminUsernames.includes(value);
  if (added) { data.adminUsernames.push(value); persist(data); }
  return { added, value };
}

export function addAdminPhone(phone) {
  const data = db();
  const value = cleanPhone(phone);
  if (!data.adminPhones) data.adminPhones = [];
  const added = !!value && !data.adminPhones.includes(value);
  if (added) { data.adminPhones.push(value); persist(data); }
  return { added, value };
}

export function isStoredAdmin(user) {
  if (!user?.id) return false;
  const data = db();
  if ((data.admins || []).some((id) => Number(id) === Number(user.id))) return true;
  const username = cleanUsername(user.username);
  return !!username && (data.adminUsernames || []).includes(username);
}

export function hasPendingAdminPhones() {
  return (db().adminPhones || []).length > 0;
}

// Номер подтверждается только контактом самого отправителя: обработчик бота
// отдельно сверяет contact.user_id с ctx.from.id.
export function claimAdminPhone(user, phone) {
  if (!user?.id) return { ok: false };
  const data = db();
  const value = cleanPhone(phone);
  if (!value || !(data.adminPhones || []).includes(value)) return { ok: false };
  if (!data.admins) data.admins = [];
  const id = Number(user.id);
  if (!data.admins.some((x) => Number(x) === id)) data.admins.push(id);
  data.adminPhones = data.adminPhones.filter((x) => x !== value); // номер больше не храним
  persist(data);
  return { ok: true, userId: id };
}

export function getAdminAccess() {
  const data = db();
  return {
    ids: (data.admins || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0),
    usernames: [...(data.adminUsernames || [])],
    phones: [...(data.adminPhones || [])],
  };
}

// ── участники ───────────────────────────────────────────────────────────
export function registerMember(doterraId, user) {
  const data = db();
  for (const [id, m] of Object.entries(data.members)) {
    if (m.userId === user.id && id !== doterraId) delete data.members[id];
  }
  const prev = data.members[doterraId] || {};
  data.members[doterraId] = {
    doterraId,
    userId: user.id,
    username: user.username || null,
    name: [user.first_name, user.last_name].filter(Boolean).join(' ') || prev.name || '',
    registeredAt: prev.registeredAt || new Date().toISOString(),
    tiers: prev.tiers || {},
  };
  delete data.flows[user.id];
  persist(data);
  return data.members[doterraId];
}

export function findMemberByUser(userId) {
  for (const m of Object.values(db().members)) if (m.userId === userId) return m;
  return null;
}

export function getMember(doterraId) {
  return db().members[doterraId] || null;
}

export function listMembers() {
  return Object.values(db().members);
}

// Состояние участника в конкретном чате (тире): 'in' | 'invited' | null (убрать).
export function setTierState(doterraId, tierKey, state) {
  const data = db();
  const m = data.members[doterraId];
  if (!m) return;
  if (!m.tiers) m.tiers = {};
  if (state) m.tiers[tierKey] = state;
  else delete m.tiers[tierKey];
  persist(data);
}

export function unbindMember(doterraId) {
  const data = db();
  const m = data.members[doterraId];
  if (!m) return null;
  delete data.members[doterraId];
  persist(data);
  return m;
}

export function rebindMember(doterraId, newUserId) {
  const data = db();
  const m = data.members[doterraId];
  if (!m) return null;
  for (const [id, mm] of Object.entries(data.members)) {
    if (mm.userId === newUserId && id !== doterraId) delete data.members[id];
  }
  m.userId = newUserId;
  m.username = null;
  m.tiers = {}; // новый аккаунт ещё нигде не состоит
  persist(data);
  return m;
}

// ── баллы ─────────────────────────────────────────────────────────────────
export function getPoints(doterraId) {
  const data = db();
  return Object.prototype.hasOwnProperty.call(data.points, doterraId) ? data.points[doterraId] : null;
}

export function commitPoints(pointsMap) {
  const data = db();
  data.points = Object.fromEntries(pointsMap);
  persist(data);
}

// ── диалог ──────────────────────────────────────────────────────────────
export function setFlow(userId, step) {
  const data = db();
  if (step) data.flows[userId] = { step };
  else delete data.flows[userId];
  persist(data);
}

export function getFlow(userId) {
  return db().flows[userId] || null;
}

// ── сессия импорта у админа (привязана к конкретному чату/тиру) ────────────
export function startImport(userId, tier) {
  const data = db();
  data.import = { tier, points: {}, files: [], by: userId, reviewed: null };
  persist(data);
}

export function addImportFile(name, records) {
  const data = db();
  if (!data.import) data.import = { tier: null, points: {}, files: [], by: null, reviewed: null };
  let added = 0;
  for (const r of records) {
    const id = String(r.id ?? '').trim();
    if (!id) continue;
    const pv = Number(r.points ?? r.pv);
    const val = Number.isFinite(pv) ? pv : 0;
    data.import.points[id] = Math.max(data.import.points[id] ?? -Infinity, val);
    added++;
  }
  data.import.files.push({ name, count: added });
  data.import.reviewed = null;
  persist(data);
  return added;
}

export function setReviewed(list) {
  const data = db();
  if (data.import) { data.import.reviewed = list; persist(data); }
}

export function getImport() {
  return db().import;
}

export function clearImport() {
  const data = db();
  data.import = null;
  persist(data);
}

// ── входящие из расширения (авто-пуш) ──────────────────────────────────────
// Расширение шлёт снимок ID·Имя·PV прямо боту (HTTP /ingest). Складываем в
// «inbox» отдельно от админской сессии импорта: тир ещё не выбран. Несколько
// выгрузок за ОДИН месяц (два кабинета) объединяем по МАКСИМУМУ PV на id.
// Пришёл другой месяц — набор начинаем заново, чтобы не тащить старые баллы.
export function ingestInbox(records, meta = {}) {
  const data = db();
  const month = String(meta.month || '').trim();
  let box = data.inbox;
  if (!box || (month && box.month && box.month !== month)) {
    box = { points: {}, month: month || (box?.month || ''), cabinets: [] };
  }
  if (month) box.month = month;
  if (!box.points) box.points = {};
  let added = 0;
  for (const r of records) {
    const id = String(r.id ?? '').trim();
    if (!id) continue;
    const pv = Number(r.points ?? r.pv);
    const val = Number.isFinite(pv) ? pv : 0;
    const prev = Object.prototype.hasOwnProperty.call(box.points, id) ? box.points[id] : -Infinity;
    box.points[id] = Math.max(prev, val);
    added++;
  }
  box.receivedAt = new Date().toISOString();
  box.cabinets = box.cabinets || [];
  box.cabinets.push({ label: String(meta.cabinet || '').trim(), count: added, at: box.receivedAt });
  box.total = Object.keys(box.points).length;
  box.ge50 = Object.values(box.points).filter((v) => v >= 50).length;
  data.inbox = box;
  persist(data);
  return { added, total: box.total, ge50: box.ge50, month: box.month, cabinets: box.cabinets.length };
}

export function getInbox() { return db().inbox || null; }

export function clearInbox() {
  const data = db();
  data.inbox = null;
  persist(data);
}

// Завести админскую сессию импорта на выбранный тир ИЗ уже полученных «входящих».
// Дальше идёт обычный путь «Посчитать → Удалить/Пригласить».
export function startImportFromInbox(userId, tier) {
  const data = db();
  const box = data.inbox;
  if (!box || !box.points || !Object.keys(box.points).length) return null;
  data.import = {
    tier,
    points: { ...box.points },
    files: [{ name: '📲 из расширения' + (box.month ? ' · ' + box.month : ''), count: Object.keys(box.points).length }],
    by: userId,
    reviewed: null,
  };
  persist(data);
  return data.import;
}
