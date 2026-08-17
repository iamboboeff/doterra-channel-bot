import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPurgePlan, parseUserIds, purgePlanCsv } from './purge-policy.js';

const user = (id, options = {}) => ({
  id: BigInt(id),
  firstName: options.firstName || `User ${id}`,
  username: options.username,
  bot: !!options.bot,
  participant: options.role ? { className: options.role } : { className: 'ChannelParticipant' },
});

test('purge plan always protects creators, admins, bots and explicit keep IDs', () => {
  const keepIds = parseUserIds('44, 55;bad');
  const plan = buildPurgePlan('-1001593559029', [
    user(11, { role: 'ChannelParticipantCreator' }),
    user(22, { role: 'ChannelParticipantAdmin' }),
    user(33, { bot: true }),
    user(44),
    user(66),
  ], keepIds);

  assert.equal(plan.total, 5);
  assert.deepEqual(plan.keep.map((row) => row.id), ['11', '22', '33', '44']);
  assert.deepEqual(plan.remove.map((row) => row.id), ['66']);
  assert.match(plan.confirmation, /^DELETE -1001593559029 1 [A-F0-9]{12}$/);
});

test('confirmation changes when the removal list changes and CSV contains the plan', () => {
  const first = buildPurgePlan('-1001593559029', [user(10)], new Set());
  const second = buildPurgePlan('-1001593559029', [user(10), user(20)], new Set());
  assert.notEqual(first.confirmation, second.confirmation);
  const csv = purgePlanCsv(first);
  assert.ok(csv.startsWith('\ufeff'));
  assert.match(csv, /"remove","ordinary_member","10"/);
});
