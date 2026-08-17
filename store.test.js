import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('registrations survive reload and backups recover a damaged store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doterra-store-'));
  process.env.STORE_DIR = dir;
  process.env.BACKUP_KEEP = '3';

  try {
    const store = await import(`./store.js?test=${Date.now()}`);
    store.registerMember('18170008', {
      id: 123456789,
      username: 'test_user',
      first_name: 'Test',
      last_name: 'Member',
    });

    assert.equal(store.getMember('18170008')?.userId, 123456789);
    assert.ok(existsSync(join(dir, 'store.json')));
    assert.ok(existsSync(join(dir, 'backups', 'latest.json')));
    assert.ok(readdirSync(join(dir, 'backups')).some((name) => name.endsWith('.json')));

    const manual = store.createBackupSnapshot('test');
    assert.equal(JSON.parse(readFileSync(manual, 'utf8')).members['18170008'].userId, 123456789);

    writeFileSync(join(dir, 'store.json'), '{broken json');
    assert.equal(store.getMember('18170008')?.userId, 123456789);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('uploads are manageable, grouped by mode/month and limited to five', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doterra-uploads-'));
  process.env.STORE_DIR = dir;

  try {
    const store = await import(`./store.js?uploads=${Date.now()}`);
    const first = store.ingestInbox(
      [{ id: '1000001', pv: 40 }, { id: '1000002', pv: 80 }],
      { month: 'Июль 2026', mode: 'closed', cabinet: 'A', name: 'a.csv' }
    );
    store.ingestInbox(
      [{ id: '1000001', pv: 65 }, { id: '1000003', pv: 30 }],
      { month: 'Июль 2026', mode: 'closed', cabinet: 'B', name: 'b.csv' }
    );

    let inbox = store.getInbox();
    assert.equal(inbox.total, 3);
    assert.equal(inbox.points['1000001'], 65);
    assert.equal(inbox.batchUploads.length, 2);

    // Повтор того же кабинета заменяет его снимок, а не оставляет старые ID.
    store.ingestInbox(
      [{ id: '1000004', pv: 90 }],
      { month: 'Июль 2026', mode: 'closed', cabinet: 'A', name: 'a-fixed.csv' }
    );
    inbox = store.getInbox();
    assert.equal(inbox.total, 3);
    assert.equal(inbox.points['1000001'], 65);
    assert.equal(inbox.points['1000002'], undefined);
    assert.equal(inbox.points['1000004'], 90);

    // Красный месяц — отдельный активный набор.
    const current = store.ingestInbox(
      [{ id: '2000001', pv: 55 }],
      { month: 'Август 2026', mode: 'current', cabinet: 'A', name: 'current.csv' }
    );
    inbox = store.getInbox();
    assert.equal(inbox.mode, 'current');
    assert.equal(inbox.total, 1);
    assert.equal(store.startImportFromInbox(1, '1', current.uploadId)?.mode, 'current');

    // Шестая сохранённая выгрузка вытесняет самую старую.
    let last;
    for (let i = 0; i < 3; i++) {
      last = store.ingestInbox(
        [{ id: String(3000000 + i), pv: i }],
        { month: `Месяц ${i}`, mode: 'current', name: `extra-${i}.csv` }
      );
    }
    assert.equal(store.listInboxUploads().length, 5);
    assert.equal(last.dropped.length, 1);
    assert.equal(store.listInboxUploads().some((u) => u.id === first.uploadId), false);

    const newest = store.listInboxUploads()[0];
    assert.equal(store.toggleInboxUploadMode(newest.id)?.mode, 'closed');
    assert.ok(store.removeInboxUpload(newest.id));
    assert.equal(store.listInboxUploads().length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('current points merge safely while a closed month replaces the snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doterra-points-'));
  process.env.STORE_DIR = dir;

  try {
    const store = await import(`./store.js?points=${Date.now()}`);
    store.commitPoints(new Map([['1000001', 80], ['1000002', 20]]), { replace: true, month: 'Июль 2026' });
    store.commitPoints(new Map([['1000002', 55]]), { replace: false, month: 'Август 2026' });
    assert.equal(store.getPoints('1000001'), 80);
    assert.equal(store.getPoints('1000002'), 55);

    store.commitPoints(new Map([['1000003', 70]]), { replace: true, month: 'Август 2026' });
    assert.equal(store.getPoints('1000001'), null);
    assert.equal(store.getPoints('1000003'), 70);
    assert.equal(store.getPointsMonth(), 'Август 2026');

    const campaign = store.startRegistrationCampaign('1');
    assert.ok(Date.parse(campaign.startedAt) <= Date.now());
    assert.equal(campaign.deadlineAt, undefined);
    assert.ok(store.finishRegistrationCampaign('1').completedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy combined inbox remains available after the upgrade', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doterra-legacy-'));
  process.env.STORE_DIR = dir;
  writeFileSync(join(dir, 'store.json'), JSON.stringify({
    members: {},
    points: {},
    flows: {},
    inbox: {
      points: { '1000001': 75 },
      month: 'Июль 2026',
      receivedAt: '2026-08-01T12:00:00.000Z',
      cabinets: [{ label: 'Старый кабинет', count: 1 }],
    },
  }));

  try {
    const store = await import(`./store.js?legacy=${Date.now()}`);
    const inbox = store.getInbox();
    assert.equal(inbox.mode, 'closed');
    assert.equal(inbox.month, 'Июль 2026');
    assert.equal(inbox.total, 1);
    assert.equal(inbox.uploads, 1);
    assert.equal(store.startImportFromInbox(1, '1')?.points['1000001'], 75);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('team provenance survives aggregation and Angelika wins duplicate IDs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doterra-teams-'));
  process.env.STORE_DIR = dir;

  try {
    const store = await import(`./store.js?teams=${Date.now()}`);
    const guest = store.ingestInbox(
      [{ id: '4000001', pv: 70 }, { id: '4000002', pv: 90 }],
      { month: 'Август 2026', mode: 'current', team: 'guest', cabinet: 'Гость №1' }
    );
    store.ingestInbox(
      [{ id: '4000001', pv: 80 }, { id: '4000003', pv: 60 }],
      { month: 'Август 2026', mode: 'current', team: 'angelika', cabinet: 'Анджелика №1' }
    );

    const inbox = store.getInbox();
    assert.equal(inbox.teams['4000001'], 'angelika');
    assert.equal(inbox.teams['4000002'], 'guest');
    assert.equal(inbox.points['4000001'], 80);
    assert.equal(store.startImportFromInbox(1, '1', guest.uploadId)?.teams['4000001'], 'angelika');

    const session = store.getImport();
    store.registerMember('4000002', { id: 42, first_name: 'Guest' });
    store.commitPoints(new Map(Object.entries(session.points)), {
      replace: false,
      month: session.month,
      teamsMap: new Map(Object.entries(session.teams)),
    });
    assert.equal(store.getMemberTeam('4000002'), 'guest');
    assert.equal(store.getMember('4000002').team, 'guest');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guest payments are monthly, user-owned and keep an audit trail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doterra-payments-'));
  process.env.STORE_DIR = dir;

  try {
    const store = await import(`./store.js?payments=${Date.now()}`);
    store.registerMember('5000001', { id: 77, first_name: 'Paying', last_name: 'Guest' });
    store.setMemberTeam('5000001', 'guest');
    assert.equal(store.getPaymentSettings().amountRub, 2000);

    const pending = store.ensurePayment('5000001', '2026-08', new Date('2026-08-15T10:00:00.000Z'));
    assert.equal(pending.status, 'pending');
    assert.equal(pending.amountRub, 2000);
    assert.equal(store.claimPayment('5000001', '2026-08', 999), null);

    const claimed = store.claimPayment('5000001', '2026-08', 77, new Date('2026-08-15T11:00:00.000Z'));
    assert.equal(claimed.status, 'claimed');
    const paid = store.setPaymentStatus('5000001', '2026-08', 'paid', { id: 1, username: 'admin' }, new Date('2026-08-15T12:00:00.000Z'));
    assert.equal(paid.status, 'paid');
    assert.equal(paid.confirmedBy.username, 'admin');
    assert.equal(store.listPayments('2026-08').length, 1);

    store.updatePaymentSettings({ amountRub: 2500, graceDays: 3, payDetails: 'Новые реквизиты' });
    assert.equal(store.getPaymentSettings().amountRub, 2500);
    assert.equal(store.getPayment('5000001', '2026-08').amountRub, 2000);
    assert.equal(store.ensurePayment('5000001', '2026-09').amountRub, 2500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
