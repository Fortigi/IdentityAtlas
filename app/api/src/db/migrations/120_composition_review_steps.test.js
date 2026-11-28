import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { VERDICTS } from '../../lib/compositionReviewSteps.js';

// The steps as migration 120 made them; migration 122 added the improvements step.
const STEPS = ['ownership', 'lifecycle', 'contents'];

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '120_composition_review_steps.sql'), 'utf8').replace(/^\s*--.*$/gm, '');
const quotedList = (values) => values.map(v => `'${v}'`).join(', ');

describe('migration 120 — a composition review is judged step by step', () => {
  it('removes the reviews of the old shape before it drops the tick they were built on', () => {
    const clear = sql.indexOf('DELETE FROM "BusinessRoleCompositionReviews";');
    const drop = sql.indexOf('ALTER TABLE "BusinessRoleCompositionReviews" DROP COLUMN "signedOff";');
    expect(clear).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(clear);
    expect(sql).toContain('ALTER TABLE "BusinessRoleCompositionReviews" DROP CONSTRAINT "ck_BusinessRoleCompositionReviews_says_something";');
  });

  it('keeps one row per step of a review, removed with the review', () => {
    expect(sql).toMatch(/"reviewId" UUID NOT NULL REFERENCES "BusinessRoleCompositionReviews"\("id"\) ON DELETE CASCADE/);
    expect(sql).toContain('UNIQUE ("reviewId", "step")');
  });

  it('allows exactly the steps and verdicts the API knows', () => {
    expect(sql).toContain(`CHECK ("step" IN (${quotedList(STEPS)}))`);
    expect(sql).toContain(`CHECK ("verdict" IN (${quotedList(VERDICTS)}))`);
  });

  it('takes proposed owners only as an object, on a change to the ownership step', () => {
    expect(sql).toMatch(/"proposal" IS NULL\s+OR \(jsonb_typeof\("proposal"\) = 'object' AND "step" = 'ownership' AND "verdict" = 'needsChange'\)/);
  });

  it('refuses a change that says neither what nor who', () => {
    expect(sql).toMatch(/"verdict" <> 'needsChange' OR btrim\("remark"\) <> '' OR "proposal" IS NOT NULL/);
  });
});
