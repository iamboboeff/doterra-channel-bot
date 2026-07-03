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
  admins: [], // userId[] — авто-админы (первые N, написавшие /start админ-боту)
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

// ── авто-админы (фолбэк: первые N, написавшие /start админ-боту) ────────────
export function getAutoAdmins() { return db().admins || []; }

export function addAutoAdmin(userId) {
  const data = db();
  if (!data.admins) data.admins = [];
  if (!data.admins.includes(userId)) { data.admins.push(userId); persist(data); }
  return data.admins;
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
