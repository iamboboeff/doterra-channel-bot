export const TEAM_ANGELIKA = 'angelika';
export const TEAM_GUEST = 'guest';
export const PAYMENT_TIME_ZONE = 'Europe/Moscow';

const RU_MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

export function normalizeTeam(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (['guest', 'гость', 'guests', 'гости'].includes(raw)) return TEAM_GUEST;
  return TEAM_ANGELIKA;
}

export function teamLabel(team) {
  return normalizeTeam(team) === TEAM_GUEST ? 'Гость' : 'Анджелика';
}

// Если ID встретился в обеих командах, команда Анджелики всегда приоритетнее.
export function resolveTeam(current, incoming) {
  const a = normalizeTeam(current);
  const b = normalizeTeam(incoming);
  return a === TEAM_ANGELIKA || b === TEAM_ANGELIKA ? TEAM_ANGELIKA : TEAM_GUEST;
}

export function billingPeriod(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PAYMENT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  return `${year}-${month}`;
}

export function periodLabel(period) {
  const match = String(period || '').match(/^(\d{4})-(\d{2})$/);
  if (!match) return String(period || 'текущий месяц');
  const month = Number(match[2]);
  return `${RU_MONTHS[month - 1] || match[2]} ${match[1]}`;
}

export function formatRub(value) {
  const amount = Math.max(0, Math.round(Number(value) || 0));
  return `${new Intl.NumberFormat('ru-RU').format(amount)} ₽`;
}

// graceDays=2 означает: за календарный месяц можно оплатить до начала третьего
// дня по Москве. Если человек впервые стал «Гостем» позже, даём ему полные два
// дня с момента назначения команды.
export function paymentDeadline(period, graceDays = 2, assignedAt = null) {
  const match = String(period || '').match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const start = Date.parse(`${period}-01T00:00:00+03:00`);
  if (!Number.isFinite(start)) return null;
  const days = Math.max(0, Math.min(31, Math.round(Number(graceDays) || 0)));
  let deadline = start + days * 24 * 60 * 60 * 1000;
  const assigned = Date.parse(assignedAt || '');
  if (Number.isFinite(assigned) && billingPeriod(new Date(assigned)) === period) {
    deadline = Math.max(deadline, assigned + days * 24 * 60 * 60 * 1000);
  }
  return new Date(deadline).toISOString();
}

export function paymentIsPaid(record) {
  return record?.status === 'paid';
}

export function paymentDeadlinePassed(record, now = new Date()) {
  const deadline = Date.parse(record?.dueAt || '');
  return Number.isFinite(deadline) && now.getTime() >= deadline;
}
