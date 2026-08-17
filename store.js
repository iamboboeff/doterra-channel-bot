// Двойное хранилище: локальный store.json + PostgreSQL, если задан DATABASE_URL.
// Файл сохраняет совместимость и локальные резервные копии, а PostgreSQL
// восстанавливает всё состояние после пересборки/замены контейнера Bothost.
//
// Членство участника хранится ПО КАЖДОМУ ЧАТУ (тиру) отдельно:
//   member.tiers = { "1": "in" | "invited", "2": "in" | "invited", ... }
//   "invited" — выдали ссылку, ждём входа; "in" — реально вступил.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  normalizeTeam,
  paymentDeadline,
  resolveTeam,
  TEAM_ANGELIKA,
  TEAM_GUEST,
} from './billing.js';
import { createPostgresStateStore, shouldPreferLocalState } from './postgres-store.js';

const DIR = process.env.STORE_DIR || process.env.DATA_DIR || dirname(fileURLToPath(import.meta.url));
const FILE = resolve(DIR, 'store.json');
const TMP = resolve(DIR, 'store.json.tmp');
const BACKUP_DIR = resolve(DIR, 'backups');
const LATEST_BACKUP = resolve(BACKUP_DIR, 'latest.json');
const BACKUP_KEEP = Math.max(3, Number(process.env.BACKUP_KEEP) || 30);
const BACKUP_INTERVAL_MS = Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS) || 6) * 60 * 60 * 1000;
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const POSTGRES_STATE_KEY = process.env.POSTGRES_STATE_KEY || 'main';
const INBOX_UPLOAD_LIMIT = 5;
const DEFAULT_PAYMENT_SETTINGS = {
  amountRub: 2000,
  graceDays: 2,
  payDetails: 'Оплата переводом по СБП. После перевода нажмите «Я оплатил(а)». Актуальные реквизиты уточняйте у администратора.',
};
let lastAutomaticBackupAt = 0;
let backupSequence = 0;
let postgres = null;
let postgresRevision = 0;
let postgresConnected = false;
let postgresLastSyncedAt = null;
let postgresLastError = null;
let postgresWriteQueue = Promise.resolve();

const EMPTY = {
  members: {}, // doterraId -> { doterraId, userId, username, name, registeredAt, tiers:{} }
  points: {}, // doterraId -> PV
  idTeams: {}, // doterraId -> { team:'angelika'|'guest', assignedAt }
  pointsMonth: '', // месяц последнего применённого полного снимка
  flows: {}, // userId -> { step }
  import: null, // { tier, points:{id:pv}, files:[], by, reviewed:[] }
  inbox: null, // { uploads:[{id,name,cabinet,month,mode,source,receivedAt,points:{id:pv}}] }
  admins: [], // userId[] — авто-админы и админы, добавленные командой /addadmin
  adminUsernames: [], // username[] — админы, добавленные командой /addadmin
  adminPhones: [], // phone[] — ожидают подтверждения контактом в Telegram
  seen: {}, // userId -> { userId, name, username, tiers:{tierKey:lastISO} } — кого бот видел в чатах
  importChannel: null, // { id, title, at } — приватный канал, куда расширение постит CSV
  adminOff: [], // userId[] — админы, временно отключившие себе панель (/adminoff)
  registrationCampaigns: {}, // tierKey -> { startedAt, completedAt? }
  paymentSettings: { ...DEFAULT_PAYMENT_SETTINGS },
  payments: {}, // doterraId -> { "YYYY-MM": { status, amountRub, dueAt, ... } }
};

function normalizePaymentSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const amountRub = Math.round(Number(source.amountRub));
  const graceDays = Math.round(Number(source.graceDays));
  return {
    amountRub: Number.isFinite(amountRub) && amountRub >= 0 ? Math.min(amountRub, 10_000_000) : DEFAULT_PAYMENT_SETTINGS.amountRub,
    graceDays: Number.isFinite(graceDays) && graceDays >= 0 ? Math.min(graceDays, 31) : DEFAULT_PAYMENT_SETTINGS.graceDays,
    payDetails: String(source.payDetails || DEFAULT_PAYMENT_SETTINGS.payDetails).trim().slice(0, 1200),
  };
}

function normalizeTeamAssignment(value, fallbackAt = null) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : { team: value };
  return {
    team: normalizeTeam(source.team),
    assignedAt: source.assignedAt || fallbackAt || null,
  };
}

function hydrate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid store format');
  const data = { ...structuredClone(EMPTY), ...raw };
  data.paymentSettings = normalizePaymentSettings(data.paymentSettings);
  if (!data.payments || typeof data.payments !== 'object' || Array.isArray(data.payments)) data.payments = {};
  if (!data.idTeams || typeof data.idTeams !== 'object' || Array.isArray(data.idTeams)) data.idTeams = {};
  for (const [id, member] of Object.entries(data.members || {})) {
    if (!member || typeof member !== 'object') continue;
    const assignment = normalizeTeamAssignment(data.idTeams[id] || member.team || TEAM_ANGELIKA, member.registeredAt);
    member.team = assignment.team;
  }
  return data;
}

function backupFiles() {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR)
    .filter((name) => /^store-.*\.json$/.test(name))
    .map((name) => {
      const path = resolve(BACKUP_DIR, name);
      return { name, path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
}

function readStore(path) {
  return hydrate(JSON.parse(readFileSync(path, 'utf8')));
}

function localCandidate() {
  const candidates = [
    ...(existsSync(FILE) ? [{ path: FILE, name: 'store.json' }] : []),
    ...(existsSync(LATEST_BACKUP) ? [{ path: LATEST_BACKUP, name: 'latest.json' }] : []),
    ...backupFiles(),
  ];
  for (const candidate of candidates) {
    try {
      return {
        data: readStore(candidate.path),
        path: candidate.path,
        name: candidate.name,
        mtimeMs: statSync(candidate.path).mtimeMs,
      };
    } catch {}
  }
  return null;
}

function db() {
  if (!existsSync(FILE)) return structuredClone(EMPTY);
  try {
    return readStore(FILE);
  } catch (error) {
    const recoveryFiles = [
      ...(existsSync(LATEST_BACKUP) ? [{ name: 'latest.json', path: LATEST_BACKUP }] : []),
      ...backupFiles(),
    ];
    for (const backup of recoveryFiles) {
      try {
        console.error(`store: основной файл повреждён, читаю резервную копию ${backup.name}`);
        return readStore(backup.path);
      } catch {}
    }
    console.error('store: база и резервные копии не читаются:', error.message);
    return structuredClone(EMPTY);
  }
}

function updateLatestBackup() {
  if (!existsSync(FILE)) return null;
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const tmp = LATEST_BACKUP + '.tmp';
    copyFileSync(FILE, tmp);
    renameSync(tmp, LATEST_BACKUP);
    return LATEST_BACKUP;
  } catch (error) {
    console.error('store latest backup:', error.message);
    return null;
  }
}

function snapshot(reason = 'auto', force = false) {
  if (!existsSync(FILE)) return null;
  const now = Date.now();
  if (!force && now - lastAutomaticBackupAt < BACKUP_INTERVAL_MS) return null;

  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const safeReason = String(reason || 'manual').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 24) || 'manual';
    const name = `store-${stamp}-${safeReason}-${backupSequence++}.json`;
    const target = resolve(BACKUP_DIR, name);
    const tmp = target + '.tmp';
    copyFileSync(FILE, tmp);
    renameSync(tmp, target);
    if (!force) lastAutomaticBackupAt = now;

    for (const old of backupFiles().slice(BACKUP_KEEP)) {
      try { unlinkSync(old.path); } catch {}
    }
    return target;
  } catch (error) {
    // Ошибка резервного копирования не должна ломать регистрацию участника:
    // основной store.json к этому моменту уже надёжно записан.
    console.error('store backup:', error.message);
    return null;
  }
}

function persistLocal(data) {
  try { mkdirSync(DIR, { recursive: true }); } catch {}
  writeFileSync(TMP, JSON.stringify(data, null, 2));
  renameSync(TMP, FILE);
  updateLatestBackup();
  snapshot('auto', false);
}

function queuePostgresWrite(data) {
  if (!postgres) return;
  const revision = ++postgresRevision;
  const payload = structuredClone(data);
  postgresWriteQueue = postgresWriteQueue
    .catch(() => {})
    .then(async () => {
      const result = await postgres.write(payload, revision);
      postgresConnected = true;
      postgresLastError = null;
      postgresLastSyncedAt = result?.updatedAt || new Date().toISOString();
    })
    .catch((error) => {
      postgresConnected = false;
      postgresLastError = error?.message || String(error);
      console.error('postgres sync:', postgresLastError);
    });
}

function persist(data) {
  persistLocal(data);
  queuePostgresWrite(data);
}

// При каждом запуске сразу делаем исторический снимок существующей базы.
// latest.json затем обновляется после КАЖДОЙ записи, без шестичасовой задержки.
if (existsSync(FILE)) {
  updateLatestBackup();
  snapshot('startup', false);
}

async function initializePostgres() {
  if (!DATABASE_URL) return;
  const adapter = createPostgresStateStore(DATABASE_URL, { stateKey: POSTGRES_STATE_KEY });
  try {
    await adapter.init();
    const [remote, local] = await Promise.all([adapter.read(), Promise.resolve(localCandidate())]);
    postgres = adapter;
    postgresConnected = true;

    if (!remote) {
      const data = local?.data || structuredClone(EMPTY);
      if (!local || local.path !== FILE) persistLocal(data);
      postgresRevision = 1;
      const result = await postgres.write(data, postgresRevision);
      postgresLastSyncedAt = result?.updatedAt || new Date().toISOString();
      console.log('✓ PostgreSQL: создано постоянное состояние бота');
      return;
    }

    postgresRevision = remote.revision;
    postgresLastSyncedAt = remote.updatedAt;
    if (local && shouldPreferLocalState(local.mtimeMs, remote.updatedAt)) {
      postgresRevision++;
      const result = await postgres.write(local.data, postgresRevision);
      postgresLastSyncedAt = result?.updatedAt || new Date().toISOString();
      if (local.path !== FILE) persistLocal(local.data);
      console.log('✓ PostgreSQL: загружена более свежая локальная база');
    } else {
      persistLocal(hydrate(remote.data));
      console.log('✓ PostgreSQL: состояние восстановлено');
    }
  } catch (error) {
    postgresConnected = false;
    postgresLastError = error?.message || String(error);
    console.error('postgres init: продолжаю с локальным store.json:', postgresLastError);
    try { await adapter.close(); } catch {}
    postgres = null;
  }
}

await initializePostgres();

export function getData() { return db(); }
export function save() {}

// Принудительный снимок для /backup. Возвращает путь к готовому JSON-файлу,
// который можно безопасно отправить только администратору в личный чат.
export function createBackupSnapshot(reason = 'manual') {
  if (!existsSync(FILE)) persist(structuredClone(EMPTY));
  return snapshot(reason, true) || FILE;
}

export function getStorageInfo() {
  const files = backupFiles();
  return {
    directory: DIR,
    file: FILE,
    backups: files.length,
    lastBackupAt: files[0] ? new Date(files[0].mtimeMs).toISOString() : null,
    members: Object.keys(db().members || {}).length,
    postgresEnabled: !!DATABASE_URL,
    postgresConnected,
    postgresLastSyncedAt,
    postgresLastError,
  };
}

export async function flushStorage() {
  await postgresWriteQueue;
}

export async function closeStorage() {
  await flushStorage();
  if (postgres) await postgres.close();
  postgres = null;
  postgresConnected = false;
}

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

// Личный выключатель панели: админ остаётся админом в конфиге, но бот общается
// с ним как с обычным участником. Нужен, чтобы проверить бота глазами человека,
// и работает поверх любого источника прав — хоть .env, хоть /addadmin.
export function isAdminOff(userId) {
  return (db().adminOff || []).some((id) => Number(id) === Number(userId));
}

export function setAdminOff(userId, off) {
  const data = db();
  const list = new Set((data.adminOff || []).map(Number));
  if (off) list.add(Number(userId));
  else list.delete(Number(userId));
  data.adminOff = [...list];
  persist(data);
  return off;
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
function teamAssignmentFromData(data, doterraId) {
  const id = String(doterraId || '').trim();
  const member = data.members?.[id];
  return normalizeTeamAssignment(data.idTeams?.[id] || member?.team || TEAM_ANGELIKA, member?.registeredAt);
}

function assignTeamInData(data, doterraId, team, at = new Date().toISOString()) {
  const id = String(doterraId || '').trim();
  if (!id) return null;
  if (!data.idTeams) data.idTeams = {};
  const nextTeam = normalizeTeam(team);
  const current = teamAssignmentFromData(data, id);
  const assignment = {
    team: nextTeam,
    assignedAt: current.team === nextTeam && current.assignedAt ? current.assignedAt : at,
  };
  data.idTeams[id] = assignment;
  if (data.members?.[id]) data.members[id].team = nextTeam;
  return assignment;
}

export function getTeamAssignment(doterraId) {
  return teamAssignmentFromData(db(), doterraId);
}

export function getMemberTeam(doterraId) {
  return getTeamAssignment(doterraId).team;
}

export function setMemberTeam(doterraId, team) {
  const data = db();
  const assignment = assignTeamInData(data, doterraId, team);
  if (assignment) persist(data);
  return assignment;
}

export function registerMember(doterraId, user) {
  const data = db();
  for (const [id, m] of Object.entries(data.members)) {
    if (m.userId === user.id && id !== doterraId) delete data.members[id];
  }
  const prev = data.members[doterraId] || {};
  const assignment = teamAssignmentFromData(data, doterraId);
  data.members[doterraId] = {
    doterraId,
    userId: user.id,
    username: user.username || null,
    name: [user.first_name, user.last_name].filter(Boolean).join(' ') || prev.name || '',
    registeredAt: prev.registeredAt || new Date().toISOString(),
    tiers: prev.tiers || {},
    team: assignment.team,
  };
  assignTeamInData(data, doterraId, assignment.team, assignment.assignedAt || new Date().toISOString());
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

// Отметка о применении нужна, чтобы в «Статусе» было видно, насколько свежие
// баллы: по старому снимку бот пускал бы людей за прошлый месяц.
export function getPointsUpdatedAt() { return db().pointsUpdatedAt || null; }
export function getPointsMonth() { return db().pointsMonth || ''; }

// Закрытый (зелёный) месяц заменяет снимок целиком. Текущий (красный) месяц
// обновляет только присланные ID и никогда не стирает остальных.
export function commitPoints(pointsMap, { replace = true, month = '', teamsMap = null } = {}) {
  const data = db();
  if (replace) data.points = Object.fromEntries(pointsMap);
  else {
    if (!data.points) data.points = {};
    for (const [id, pv] of pointsMap) {
      const val = Number(pv);
      if (!Number.isFinite(val)) continue;
      const prev = Object.prototype.hasOwnProperty.call(data.points, id) ? Number(data.points[id]) : -Infinity;
      data.points[id] = Math.max(Number.isFinite(prev) ? prev : -Infinity, val);
    }
  }
  const teamEntries = teamsMap instanceof Map ? [...teamsMap.entries()] : Object.entries(teamsMap || {});
  const now = new Date().toISOString();
  for (const [rawId, team] of teamEntries) {
    const id = String(rawId || '').trim();
    if (!id || !pointsMap.has(id)) continue;
    assignTeamInData(data, id, team, now);
  }
  if (month) data.pointsMonth = month;
  data.pointsUpdatedAt = new Date().toISOString();
  persist(data);
}

// ── ежемесячная оплата команды «Гость» ───────────────────────────────────
export function getPaymentSettings() {
  return normalizePaymentSettings(db().paymentSettings);
}

export function updatePaymentSettings(patch = {}) {
  const data = db();
  const before = normalizePaymentSettings(data.paymentSettings);
  data.paymentSettings = normalizePaymentSettings({ ...data.paymentSettings, ...patch });
  if (data.paymentSettings.amountRub !== before.amountRub) {
    for (const periods of Object.values(data.payments || {})) {
      for (const record of Object.values(periods || {})) {
        if (record && (record.status === 'pending' || record.status === 'rejected')) {
          record.amountRub = data.paymentSettings.amountRub;
        }
      }
    }
  }
  persist(data);
  return data.paymentSettings;
}

function normalizePaymentRecord(record, doterraId, period) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  return {
    ...record,
    doterraId: String(doterraId),
    period: String(period),
    status: ['pending', 'claimed', 'paid', 'rejected'].includes(record.status) ? record.status : 'pending',
    amountRub: Math.max(0, Math.round(Number(record.amountRub) || 0)),
    adminMessages: record.adminMessages && typeof record.adminMessages === 'object' ? record.adminMessages : {},
  };
}

function ensurePaymentInData(data, doterraId, period, now = new Date()) {
  const id = String(doterraId || '').trim();
  const key = String(period || '').trim();
  if (!id || !/^\d{4}-\d{2}$/.test(key)) return { record: null, created: false };
  if (!data.payments) data.payments = {};
  if (!data.payments[id] || typeof data.payments[id] !== 'object') data.payments[id] = {};
  const existing = normalizePaymentRecord(data.payments[id][key], id, key);
  if (existing) {
    data.payments[id][key] = existing;
    return { record: existing, created: false };
  }
  const settings = normalizePaymentSettings(data.paymentSettings);
  const assignment = teamAssignmentFromData(data, id);
  const record = {
    doterraId: id,
    period: key,
    status: 'pending',
    amountRub: settings.amountRub,
    dueAt: paymentDeadline(key, settings.graceDays, assignment.team === TEAM_GUEST ? assignment.assignedAt : null),
    createdAt: now.toISOString(),
    adminMessages: {},
  };
  data.payments[id][key] = record;
  return { record, created: true };
}

export function ensurePayment(doterraId, period, now = new Date()) {
  const data = db();
  const result = ensurePaymentInData(data, doterraId, period, now);
  if (result.created) persist(data);
  return result.record;
}

export function getPayment(doterraId, period) {
  const data = db();
  return normalizePaymentRecord(data.payments?.[String(doterraId)]?.[String(period)], doterraId, period);
}

export function listPayments(period = null) {
  const data = db();
  const out = [];
  for (const [id, periods] of Object.entries(data.payments || {})) {
    for (const [key, value] of Object.entries(periods || {})) {
      if (period && key !== String(period)) continue;
      const record = normalizePaymentRecord(value, id, key);
      if (record) out.push(record);
    }
  }
  return out.sort((a, b) => String(b.claimedAt || b.confirmedAt || b.createdAt || '').localeCompare(String(a.claimedAt || a.confirmedAt || a.createdAt || '')));
}

export function claimPayment(doterraId, period, userId, now = new Date()) {
  const data = db();
  const member = data.members?.[String(doterraId)];
  if (!member || Number(member.userId) !== Number(userId) || teamAssignmentFromData(data, doterraId).team !== TEAM_GUEST) return null;
  const { record } = ensurePaymentInData(data, doterraId, period, now);
  if (!record) return null;
  if (record.status !== 'paid') {
    record.status = 'claimed';
    record.claimedAt = now.toISOString();
    delete record.rejectedAt;
    delete record.rejectedBy;
  }
  persist(data);
  return record;
}

export function setPaymentStatus(doterraId, period, status, admin = {}, now = new Date()) {
  if (!['paid', 'rejected', 'pending'].includes(status)) return null;
  const data = db();
  const { record } = ensurePaymentInData(data, doterraId, period, now);
  if (!record) return null;
  const who = {
    id: Number(admin.id) || null,
    username: admin.username || null,
    name: [admin.first_name, admin.last_name].filter(Boolean).join(' ') || admin.name || '',
  };
  record.status = status;
  if (status === 'paid') {
    record.confirmedAt = now.toISOString();
    record.confirmedBy = who;
    delete record.rejectedAt;
    delete record.rejectedBy;
    delete record.removedAt;
  } else if (status === 'rejected') {
    record.rejectedAt = now.toISOString();
    record.rejectedBy = who;
    delete record.confirmedAt;
    delete record.confirmedBy;
  } else {
    record.cancelledAt = now.toISOString();
    record.cancelledBy = who;
    delete record.confirmedAt;
    delete record.confirmedBy;
    delete record.rejectedAt;
    delete record.rejectedBy;
  }
  persist(data);
  return record;
}

export function setPaymentAdminMessage(doterraId, period, adminId, messageId) {
  const data = db();
  const { record } = ensurePaymentInData(data, doterraId, period);
  if (!record) return null;
  if (!record.adminMessages) record.adminMessages = {};
  record.adminMessages[String(adminId)] = Number(messageId);
  persist(data);
  return record;
}

export function markPaymentReminder(doterraId, period, at = new Date()) {
  const data = db();
  const { record } = ensurePaymentInData(data, doterraId, period, at);
  if (!record) return null;
  record.remindedAt = at.toISOString();
  persist(data);
  return record;
}

export function markPaymentRemoved(doterraId, period, at = new Date()) {
  const data = db();
  const { record } = ensurePaymentInData(data, doterraId, period, at);
  if (!record) return null;
  record.removedAt = at.toISOString();
  persist(data);
  return record;
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
export function startImport(userId, tier, mode = 'closed') {
  const data = db();
  data.import = { tier, mode, month: '', points: {}, files: [], by: userId, reviewed: null };
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

// ── входящие из расширения/Telegram ────────────────────────────────────────
// Храним до пяти исходных выгрузок отдельно. Это позволяет удалить ошибочную
// выгрузку и пересчитать объединение без повторной отправки остальных файлов.
// Активный набор — режим+месяц самой новой выгрузки. Внутри набора одинаковые
// ID объединяются по максимуму PV (два кабинета).
export function getImportChannel() { return db().importChannel || null; }

export function setImportChannel(id, title) {
  const data = db();
  data.importChannel = { id, title: title || '', at: Date.now() };
  persist(data);
  return data.importChannel;
}

const cleanInboxMode = (mode) => String(mode || '').toLowerCase() === 'closed' ? 'closed' : 'current';

function normalizeUpload(upload, fallback = {}) {
  if (!upload || typeof upload !== 'object') return null;
  const points = {};
  for (const [rawId, rawPv] of Object.entries(upload.points || {})) {
    const id = String(rawId || '').trim();
    const pv = Number(rawPv);
    if (id && Number.isFinite(pv)) points[id] = pv;
  }
  return {
    id: String(upload.id || fallback.id || `legacy-${Date.now().toString(36)}`),
    name: String(upload.name || fallback.name || 'выгрузка.csv'),
    team: normalizeTeam(upload.team ?? fallback.team),
    cabinet: String(upload.cabinet ?? upload.label ?? fallback.cabinet ?? '').trim(),
    month: String(upload.month ?? fallback.month ?? '').trim(),
    mode: cleanInboxMode(upload.mode ?? fallback.mode),
    source: String(upload.source || fallback.source || 'legacy'),
    receivedAt: upload.receivedAt || upload.at || fallback.receivedAt || new Date().toISOString(),
    points,
  };
}

function normalizeInbox(raw) {
  if (!raw) return { uploads: [] };
  if (Array.isArray(raw.uploads)) {
    return { uploads: raw.uploads.map((u, i) => normalizeUpload(u, { id: `upload-${i + 1}` })).filter(Boolean).slice(-INBOX_UPLOAD_LIMIT) };
  }
  // Совместимость с прежней базой: объединённый inbox становится одной
  // управляемой зелёной выгрузкой и ничего не теряется при обновлении кода.
  if (raw.points && typeof raw.points === 'object' && Object.keys(raw.points).length) {
    const legacy = normalizeUpload(
      { points: raw.points },
      {
        id: `legacy-${Date.parse(raw.receivedAt || '') || Date.now()}`,
        name: 'выгрузка до обновления',
        team: TEAM_ANGELIKA,
        cabinet: (raw.cabinets || []).map((c) => c.label).filter(Boolean).join(' + '),
        month: raw.month || '',
        mode: 'closed',
        source: 'legacy',
        receivedAt: raw.receivedAt,
      }
    );
    return { uploads: legacy ? [legacy] : [] };
  }
  return { uploads: [] };
}

function aggregateUploads(uploads, anchorId = null) {
  const anchor = anchorId ? uploads.find((u) => u.id === anchorId) : uploads[uploads.length - 1];
  if (!anchor) return null;
  const batch = uploads.filter((u) => u.mode === anchor.mode && u.month === anchor.month);
  const points = {};
  const teams = {};
  for (const upload of batch) {
    for (const [id, pv] of Object.entries(upload.points || {})) {
      points[id] = Math.max(Object.prototype.hasOwnProperty.call(points, id) ? points[id] : -Infinity, pv);
      teams[id] = Object.prototype.hasOwnProperty.call(teams, id)
        ? resolveTeam(teams[id], upload.team)
        : normalizeTeam(upload.team);
    }
  }
  return {
    anchorId: anchor.id,
    mode: anchor.mode,
    month: anchor.month,
    receivedAt: anchor.receivedAt,
    points,
    teams,
    total: Object.keys(points).length,
    ge50: Object.values(points).filter((v) => v >= 50).length,
    batchUploads: batch,
  };
}

export function ingestInbox(records, meta = {}) {
  const data = db();
  const inbox = normalizeInbox(data.inbox);
  const month = String(meta.month || '').trim();
  const mode = cleanInboxMode(meta.mode);
  const team = normalizeTeam(meta.team);
  const cabinet = String(meta.cabinet || '').trim();
  const points = {};
  let added = 0;
  for (const r of records) {
    const id = String(r.id ?? '').trim();
    if (!id) continue;
    const pv = Number(r.points ?? r.pv);
    const val = Number.isFinite(pv) ? pv : 0;
    points[id] = Math.max(Object.prototype.hasOwnProperty.call(points, id) ? points[id] : -Infinity, val);
    added++;
  }

  // Повторная выгрузка того же подписанного кабинета заменяет старую версию.
  if (cabinet) {
    inbox.uploads = inbox.uploads.filter((u) => !(
      u.mode === mode &&
      u.month === month &&
      u.team === team &&
      u.cabinet.toLowerCase() === cabinet.toLowerCase()
    ));
  }
  const receivedAt = new Date().toISOString();
  const upload = normalizeUpload({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: meta.name || 'выгрузка.csv',
    team,
    cabinet,
    month,
    mode,
    source: meta.source || 'manual',
    receivedAt,
    points,
  });
  inbox.uploads.push(upload);
  const dropped = inbox.uploads.length > INBOX_UPLOAD_LIMIT
    ? inbox.uploads.splice(0, inbox.uploads.length - INBOX_UPLOAD_LIMIT)
    : [];
  data.inbox = inbox;
  persist(data);
  const active = aggregateUploads(inbox.uploads, upload.id);
  return {
    added,
    uploadId: upload.id,
    total: active.total,
    ge50: active.ge50,
    month: active.month,
    mode: active.mode,
    batchUploads: active.batchUploads.length,
    angelika: Object.values(active.teams).filter((value) => value === TEAM_ANGELIKA).length,
    guests: Object.values(active.teams).filter((value) => value === TEAM_GUEST).length,
    uploads: inbox.uploads.length,
    dropped: dropped.map((u) => ({ id: u.id, name: u.name, cabinet: u.cabinet })),
  };
}

export function getInbox(anchorId = null) {
  const inbox = normalizeInbox(db().inbox);
  const active = aggregateUploads(inbox.uploads, anchorId);
  if (!active) return null;
  return {
    ...active,
    uploads: inbox.uploads.length,
    allUploads: inbox.uploads.map((u) => ({
      id: u.id,
      name: u.name,
      team: u.team,
      cabinet: u.cabinet,
      month: u.month,
      mode: u.mode,
      source: u.source,
      receivedAt: u.receivedAt,
      count: Object.keys(u.points || {}).length,
      ge50: Object.values(u.points || {}).filter((v) => v >= 50).length,
    })),
  };
}

export function listInboxUploads() {
  return (getInbox()?.allUploads || []).slice().reverse();
}

export function removeInboxUpload(uploadId) {
  const data = db();
  const inbox = normalizeInbox(data.inbox);
  const index = inbox.uploads.findIndex((u) => u.id === String(uploadId));
  if (index < 0) return null;
  const [removed] = inbox.uploads.splice(index, 1);
  data.inbox = inbox.uploads.length ? inbox : null;
  persist(data);
  return removed;
}

export function toggleInboxUploadMode(uploadId) {
  const data = db();
  const inbox = normalizeInbox(data.inbox);
  const upload = inbox.uploads.find((u) => u.id === String(uploadId));
  if (!upload) return null;
  upload.mode = upload.mode === 'closed' ? 'current' : 'closed';
  data.inbox = inbox;
  persist(data);
  return { id: upload.id, mode: upload.mode };
}

export function clearInbox() {
  const data = db();
  data.inbox = null;
  persist(data);
}

// Завести админскую сессию импорта на выбранный тир ИЗ уже полученных «входящих».
// Дальше идёт обычный путь «Посчитать → Удалить/Пригласить».
export function startImportFromInbox(userId, tier, anchorId = null) {
  const data = db();
  const inbox = normalizeInbox(data.inbox);
  const box = aggregateUploads(inbox.uploads, anchorId);
  if (!box || !Object.keys(box.points).length) return null;
  data.import = {
    tier,
    mode: box.mode,
    month: box.month,
    points: { ...box.points },
    teams: { ...box.teams },
    files: box.batchUploads.map((u) => ({ name: u.name, count: Object.keys(u.points || {}).length, uploadId: u.id })),
    by: userId,
    reviewed: null,
  };
  persist(data);
  return data.import;
}

// ── месячная кампания регистрации ─────────────────────────────────────────
export function startRegistrationCampaign(tierKey) {
  const data = db();
  if (!data.registrationCampaigns) data.registrationCampaigns = {};
  const startedAt = new Date();
  data.registrationCampaigns[String(tierKey)] = {
    startedAt: startedAt.toISOString(),
    completedAt: null,
  };
  persist(data);
  return data.registrationCampaigns[String(tierKey)];
}

export function getRegistrationCampaign(tierKey) {
  return db().registrationCampaigns?.[String(tierKey)] || null;
}

export function finishRegistrationCampaign(tierKey) {
  const data = db();
  const campaign = data.registrationCampaigns?.[String(tierKey)];
  if (!campaign) return null;
  campaign.completedAt = new Date().toISOString();
  persist(data);
  return campaign;
}
