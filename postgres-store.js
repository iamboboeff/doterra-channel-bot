import pg from 'pg';

const { Pool } = pg;

const TABLE = 'doterra_bot_state';

function safeRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

// PostgreSQL intentionally stores one complete JSONB document. The public store
// API stays synchronous, while PostgreSQL becomes a durable off-container copy
// of the exact same state. A revision guard prevents an older queued write from
// overwriting a newer snapshot.
export function createPostgresStateStore(connectionString, { stateKey = 'main' } = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is empty');

  const pool = new Pool({
    connectionString,
    application_name: 'doterra-channel-bot',
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    max: 2,
  });

  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        state_key TEXT PRIMARY KEY,
        revision BIGINT NOT NULL DEFAULT 0,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async function read() {
    const result = await pool.query(
      `SELECT revision, payload, updated_at FROM ${TABLE} WHERE state_key = $1`,
      [stateKey]
    );
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return {
      revision: safeRevision(row.revision),
      data: row.payload,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }

  async function write(data, revision) {
    const nextRevision = safeRevision(revision);
    const result = await pool.query(
      `
        INSERT INTO ${TABLE} (state_key, revision, payload, updated_at)
        VALUES ($1, $2, $3::jsonb, NOW())
        ON CONFLICT (state_key) DO UPDATE
          SET revision = EXCLUDED.revision,
              payload = EXCLUDED.payload,
              updated_at = NOW()
        WHERE ${TABLE}.revision <= EXCLUDED.revision
        RETURNING revision, updated_at
      `,
      [stateKey, nextRevision, JSON.stringify(data)]
    );
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return {
      revision: safeRevision(row.revision),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }

  async function close() {
    await pool.end();
  }

  return { init, read, write, close };
}

export function shouldPreferLocalState(localMtimeMs, remoteUpdatedAt) {
  const remoteTime = Date.parse(remoteUpdatedAt || '');
  return Number.isFinite(localMtimeMs) && (!Number.isFinite(remoteTime) || localMtimeMs > remoteTime + 1_000);
}
