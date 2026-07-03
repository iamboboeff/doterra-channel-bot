// Файловое хранилище в store.json.
// ВАЖНО: каждая операция читает свежую версию файла с диска и сразу пишет
// обратно. Это позволяет запускать бота участников и админ-бота как ДВА
// ОТДЕЛЬНЫХ процесса (например две записи на bothost), которые делят один
// store.json на общем диске и видят данные друг друга. STORE_DIR должен
// указывать на ОБЩЕЕ постоянное хранилище (на bothost — /app/shared при
// включённом «Общем хранилище»).
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DIR = process.env.STORE_DIR || dirname(fileURLToPath(import.meta.url));
const FILE = resolve(DIR, 'store.json');
const TMP = resolve(DIR, 'store.json.tmp');

const EMPTY = {
  members: {}, // doterraId -> { doterraId, userId, username, name, registeredAt, invited, inChannel }
  points: {}, // doterraId -> PV (последний снимок баллов)
  flows: {}, // userId -> { step }
  import: null, // { points:{id:pv}, files:[{name,count}], by, reviewed:[{doterraId,userId,pv}] }
};

// Свежая версия с диска.
function db() {
  if (!existsSync(FILE)) return structuredClone(EMPTY);
  try {
    return { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(FILE, 'utf8')) };
  } catch {
    return structuredClone(EMPTY);
  }
}

// Атомичная запись (temp + rename), с созданием папки при необходимости.
function persist(data) {
  try { mkdirSync(DIR, { recursive: true }); } catch {}
  writeFileSync(TMP, JSON.stringify(data, null, 2));
  renameSync(TMP, FILE);
}

export function getData() { return db(); }
export function save() { /* каждая операция пишет сама — оставлено для совместимости */ }

// ── участники ───────────────────────────────────────────────────────────
export function registerMember(doterraId, user) {
  const data = db();
  // один Telegram-пользователь = одна регистрация: убираем прежнюю запись под другим ID
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
    invited: prev.invited || false,
    inChannel: prev.inChannel || false,
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

export function setInChannel(doterraId, value) {
  const data = db();
  if (data.members[doterraId]) { data.members[doterraId].inChannel = value; persist(data); }
}

export function setInvited(doterraId, value) {
  const data = db();
  if (data.members[doterraId]) { data.members[doterraId].invited = value; persist(data); }
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
  m.invited = false;
  m.inChannel = false;
  persist(data);
  return m;
}

// ── баллы ─────────────────────────────────────────────────────────────────
export function getPoints(doterraId) {
  const data = db();
  return Object.prototype.hasOwnProperty.call(data.points, doterraId) ? data.points[doterraId] : null;
}

export function commitPoints(pointsMap) {
  const data = db(); // свежие members сохраняются, меняем только снимок баллов
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

// ── сессия импорта у админа ───────────────────────────────────────────────
export function startImport(userId) {
  const data = db();
  data.import = { points: {}, files: [], by: userId, reviewed: null };
  persist(data);
}

export function addImportFile(name, records) {
  const data = db();
  if (!data.import) data.import = { points: {}, files: [], by: null, reviewed: null };
  let added = 0;
  for (const r of records) {
    const id = String(r.id ?? '').trim();
    if (!id) continue;
    const pv = Number(r.points ?? r.pv);
    const val = Number.isFinite(pv) ? pv : 0; // пусто = 0
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
