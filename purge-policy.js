import { createHash } from 'node:crypto';

const roleName = (participant) => String(
  participant?.className || participant?.constructor?.name || 'member'
);

export function parseUserIds(value) {
  return new Set(
    String(value || '')
      .split(/[\s,;]+/)
      .map((id) => id.trim())
      .filter((id) => /^\d+$/.test(id))
  );
}

export function participantRecord(user, keepIds = new Set()) {
  const id = String(user?.id ?? '').trim();
  const role = roleName(user?.participant);
  const creator = /Creator$/i.test(role);
  const admin = /Admin$/i.test(role);
  const bot = !!user?.bot;
  const explicitKeep = keepIds.has(id);
  const keep = creator || admin || bot || explicitKeep;
  const reason = creator
    ? 'creator'
    : admin
      ? 'admin'
      : bot
        ? 'bot'
        : explicitKeep
          ? 'allowlist'
          : 'ordinary_member';

  return {
    id,
    username: String(user?.username || ''),
    name: [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim(),
    role,
    action: keep ? 'keep' : 'remove',
    reason,
  };
}

export function buildPurgePlan(chatId, users, keepIds = new Set()) {
  const participants = users
    .map((user) => participantRecord(user, keepIds))
    .filter((row) => /^\d+$/.test(row.id));
  const remove = participants.filter((row) => row.action === 'remove');
  const keep = participants.filter((row) => row.action === 'keep');
  const ids = remove.map((row) => row.id).sort();
  const fingerprint = createHash('sha256')
    .update(`${chatId}\n${ids.join('\n')}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();

  return {
    chatId: String(chatId),
    total: participants.length,
    remove,
    keep,
    fingerprint,
    confirmation: `DELETE ${chatId} ${remove.length} ${fingerprint}`,
  };
}

const csvCell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;

export function purgePlanCsv(plan) {
  const rows = [...plan.keep, ...plan.remove];
  const header = ['action', 'reason', 'telegram_id', 'name', 'username', 'role'];
  return '\ufeff' + [
    header.map(csvCell).join(','),
    ...rows.map((row) => [
      row.action,
      row.reason,
      row.id,
      row.name,
      row.username,
      row.role,
    ].map(csvCell).join(',')),
  ].join('\r\n');
}
