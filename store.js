// Файловое хранилище в store.json. Хватает для канала на сотни человек.
// Когда выложим на Cloud Run — заменим только этот модуль на Google-таблицу,
// логика ботов не изменится.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Где хранить store.json. На хостинге с постоянным диском (Volume) задайте
// переменную STORE_DIR = путь к диску (например /data) — иначе файл сотрётся
// при перезапуске, и все регистрации потеряются.
const DIR = process.env.STORE_DIR || dirname(fileURLToPath(import.meta.url));
const FILE = resolve(DIR, 'store.json');
const TMP = resolve(DIR, 'store.json.tmp');

const EMPTY = {
  // doterraId -> { doterraId, userId, username, name, registeredAt, invited, inChannel }
  //   invited   — выдали ссылку-приглашение (ждём фактического входа)
  //   inChannel — реально вступил (по событию chat_member) → только таких удаляем
  members: {},
  // doterraId -> PV (последний загруженный снимок баллов)
  points: {},
  // userId -> { step }  состояние диалога (например awaiting_id)
  flows: {},
  // незавершённая сессия импорта у админа:
  //   { points:{id:pv}, files:[{name,count}], by, reviewed:[{doterraId,userId,pv}] }
  import: null,
};

let data = load();

function load() {
  if (!existsSync(FILE)) return structuredClone(EMPTY);
  try {
    return { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(FILE, 'utf8')) };
  } catch {
    return structuredClone(EMPTY);
  }
}

// Атомичная запись: пишем во временный файл и переименовываем — так падение
// посреди записи не оставит битый store.json.
export function save() {
  writeFileSync(TMP, JSON.stringify(data, null, 2));
  renameSync(TMP, FILE);
}

export function getData() {
  return data;
}

// ── участники ───────────────────────────────────────────────────────────
export function registerMember(doterraId, user) {
  // Один Telegram-пользователь = одна регистрация: убираем его прежнюю запись
  // под другим doTERRA ID (на случай, если ошибся и прислал новый).
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
  save();
  return data.members[doterraId];
}

export function findMemberByUser(userId) {
  for (const m of Object.values(data.members)) if (m.userId === userId) return m;
  return null;
}

export function getMember(doterraId) {
  return data.members[doterraId] || null;
}

export function listMembers() {
  return Object.values(data.members);
}

export function setInChannel(doterraId, value) {
  if (data.members[doterraId]) {
    data.members[doterraId].inChannel = value;
    save();
  }
}

export function setInvited(doterraId, value) {
  if (data.members[doterraId]) {
    data.members[doterraId].invited = value;
    save();
  }
}

// Снять привязку ID (освободить). Возвращает удалённую запись или null.
export function unbindMember(doterraId) {
  const m = data.members[doterraId];
  if (!m) return null;
  delete data.members[doterraId];
  save();
  return m;
}

// Перепривязать существующий ID на другой Telegram-аккаунт.
// Сбрасывает статусы (новый аккаунт ещё не приглашён и не в канале).
export function rebindMember(doterraId, newUserId) {
  const m = data.members[doterraId];
  if (!m) return null;
  // если у нового аккаунта была своя регистрация под другим ID — убираем её
  for (const [id, mm] of Object.entries(data.members)) {
    if (mm.userId === newUserId && id !== doterraId) delete data.members[id];
  }
  m.userId = newUserId;
  m.username = null;
  m.invited = false;
  m.inChannel = false;
  save();
  return m;
}

// ── баллы (последний снимок) ──────────────────────────────────────────────
export function getPoints(doterraId) {
  return Object.prototype.hasOwnProperty.call(data.points, doterraId) ? data.points[doterraId] : null;
}

export function commitPoints(pointsMap) {
  // pointsMap: Map<id, pv> — заменяем снимок целиком
  data.points = Object.fromEntries(pointsMap);
  save();
}

// ── состояние диалога ─────────────────────────────────────────────────────
export function setFlow(userId, step) {
  if (step) data.flows[userId] = { step };
  else delete data.flows[userId];
  save();
}

export function getFlow(userId) {
  return data.flows[userId] || null;
}

// ── сессия импорта у админа ───────────────────────────────────────────────
export function startImport(userId) {
  data.import = { points: {}, files: [], by: userId, reviewed: null };
  save();
}

export function addImportFile(name, records) {
  if (!data.import) startImport(null);
  let added = 0;
  for (const r of records) {
    const id = String(r.id ?? '').trim();
    if (!id) continue;
    const pv = Number(r.points ?? r.pv);
    // Пустой/битый PV = 0 баллов (по решению заказчика: пусто = неактивен).
    const val = Number.isFinite(pv) ? pv : 0;
    // дубль из двух кабинетов — берём максимум
    data.import.points[id] = Math.max(data.import.points[id] ?? -Infinity, val);
    added++;
  }
  data.import.files.push({ name, count: added });
  data.import.reviewed = null; // новый файл — прежний расчёт больше не актуален
  save();
  return added;
}

// Замораживаем список «на вылет», который показали админу, — именно его (и
// только его) применит подтверждение. Ничего нового в момент бана не добавится.
export function setReviewed(list) {
  if (data.import) {
    data.import.reviewed = list;
    save();
  }
}

export function getImport() {
  return data.import;
}

export function clearImport() {
  data.import = null;
  save();
}
