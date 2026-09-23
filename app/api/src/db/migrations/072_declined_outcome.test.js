import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { OUTCOMES } from '../../nlreports/conversations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '072_declined_outcome.sql'), 'utf8');

describe('migration 072 — a declined outcome', () => {
  it('replaces the outcome check idempotently and admits every outcome the code can write', () => {
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS "ck_BotConversations_outcome"/);
    const list = sql.match(/CHECK \("outcome" IN \(([^)]*)\)/)[1];
    const admitted = [...list.matchAll(/'([^']+)'/g)].map(m => m[1]);
    for (const outcome of Object.values(OUTCOMES)) expect(admitted, outcome).toContain(outcome);
    expect(admitted).toContain('declined');
  });
});
