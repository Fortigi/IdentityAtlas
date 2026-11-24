import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(__dirname, '115_assignment_policy_participants.sql'), 'utf8').replace(/^\s*--.*$/gm, '');

describe('migration 115 — policy participants', () => {
  it('adds a nullable JSON list, so "not stated" stays different from "nobody"', () => {
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "participants" JSONB;/);
    expect(code).not.toMatch(/NOT NULL|DEFAULT/);
  });
});
