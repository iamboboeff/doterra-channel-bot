import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldPreferLocalState } from './postgres-store.js';

test('startup prefers only a meaningfully newer local snapshot', () => {
  const remote = '2026-08-17T10:00:00.000Z';
  assert.equal(shouldPreferLocalState(Date.parse('2026-08-17T10:00:00.500Z'), remote), false);
  assert.equal(shouldPreferLocalState(Date.parse('2026-08-17T10:00:02.000Z'), remote), true);
  assert.equal(shouldPreferLocalState(Date.parse('2026-08-17T09:59:59.000Z'), remote), false);
});
