import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '116_business_role_composition_reviews.sql'), 'utf8').replace(/^\s*--.*$/gm, '');

describe('migration 116 — business role composition reviews', () => {
  it('keeps every review as its own row, newest first per role', () => {
    expect(sql).toMatch(/"id"\s+UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    expect(sql).toMatch(/CREATE INDEX "ix_BusinessRoleCompositionReviews_role" ON "BusinessRoleCompositionReviews" \("resourceId", "reviewedAt" DESC\)/);
  });

  it('records who reviewed and when', () => {
    expect(sql).toMatch(/"reviewedBy"\s+TEXT NOT NULL,/);
    expect(sql).toMatch(/"reviewedByName" TEXT,/);
    expect(sql).toMatch(/"reviewedAt"\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
  });

  it('always stores a snapshot of what was reviewed, as an object', () => {
    expect(sql).toMatch(/"snapshot"\s+JSONB NOT NULL,/);
    expect(sql).toMatch(/CHECK \(jsonb_typeof\("snapshot"\) = 'object'\)/);
  });

  it('refuses a review that neither signs off nor says anything', () => {
    expect(sql).toMatch(/CHECK \("signedOff" OR btrim\("notes"\) <> ''\)/);
  });

  it('removes the reviews with their role', () => {
    expect(sql).toMatch(/"resourceId"\s+UUID NOT NULL REFERENCES "Resources"\("id"\) ON DELETE CASCADE/);
  });
});
