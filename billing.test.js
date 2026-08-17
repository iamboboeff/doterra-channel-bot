import assert from 'node:assert/strict';
import test from 'node:test';
import {
  billingPeriod,
  formatRub,
  paymentDeadline,
  periodLabel,
  resolveTeam,
  TEAM_ANGELIKA,
  TEAM_GUEST,
} from './billing.js';
import { parseUploadCaption, parseUploadCsvMeta, resolveUploadMeta } from './upload-meta.js';

test('billing periods and two-day Moscow grace are deterministic', () => {
  assert.equal(billingPeriod(new Date('2026-08-31T22:30:00.000Z')), '2026-09');
  assert.equal(periodLabel('2026-08'), 'Август 2026');
  assert.equal(paymentDeadline('2026-08', 2), '2026-08-02T21:00:00.000Z');
  assert.equal(
    paymentDeadline('2026-08', 2, '2026-08-15T10:00:00.000Z'),
    '2026-08-17T10:00:00.000Z'
  );
  assert.equal(formatRub(2000), '2 000 ₽');
});

test('Angelika wins a duplicate ID and captions stay backward compatible', () => {
  assert.equal(resolveTeam(TEAM_GUEST, TEAM_ANGELIKA), TEAM_ANGELIKA);
  assert.equal(resolveTeam(TEAM_GUEST, TEAM_GUEST), TEAM_GUEST);
  assert.deepEqual(parseUploadCaption('{"team":"guest","cabinet":"Анна №1"}'), {
    team: TEAM_GUEST,
    cabinet: 'Анна №1',
  });
  assert.deepEqual(parseUploadCaption('Старый кабинет'), {
    team: TEAM_ANGELIKA,
    cabinet: 'Старый кабинет',
  });
});

test('team and cabinet survive a manually forwarded CSV', () => {
  const csvMeta = parseUploadCsvMeta([
    ['ID', 'Имя', 'PV', 'Команда', 'Кабинет'],
    ['1000001', 'Один', '50', 'Гость', 'Анна №1'],
    ['1000002', 'Два', '70', 'Гость', 'Анна №1'],
  ]);
  assert.deepEqual(csvMeta, { team: TEAM_GUEST, cabinet: 'Анна №1' });
  assert.deepEqual(resolveUploadMeta('', csvMeta), csvMeta);
  assert.deepEqual(resolveUploadMeta('{"team":"angelika","cabinet":"Ручной"}', csvMeta), {
    team: TEAM_ANGELIKA,
    cabinet: 'Ручной',
  });
});
