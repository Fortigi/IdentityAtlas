import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '073_first_reply.sql'), 'utf8');

describe('migration 073 — the first reply', () => {
  it('adds the column idempotently, nullable, and says when it is filled', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "firstReply" TEXT/);
    expect(sql).not.toMatch(/NOT NULL/);
    expect(sql).toMatch(/only when a correction round replaced it/);
  });
});
