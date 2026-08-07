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
