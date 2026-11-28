import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { STEPS } from '../../lib/compositionReviewSteps.js';

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, '122_composition_review_improvements.sql'), 'utf8').replace(/^\s*--.*$/gm, '');
const quoted = STEPS.map(s => `'${s}'`).join(', ');
const jsonList = `'[${STEPS.map(s => `"${s}"`).join(', ')}]'::jsonb`;

describe('migration 122 — the improvements step', () => {
  it('lets a review judge exactly the steps the API knows, the improvements step last', () => {
    expect(STEPS.at(-1)).toBe('improvements');
    expect(sql).toContain(`CHECK ("step" IN (${quoted}))`);
  });

  it('lets a campaign ask exactly those steps', () => {
    expect(sql).toContain(`"steps" <@ ${jsonList}`);
  });

  it('replaces each constraint it changes, dropping it first', () => {
    for (const name of ['ck_BusinessRoleCompositionReviewSteps_step', 'ck_BusinessRoleCompositionReviewSteps_proposal', 'ck_ReviewCampaigns_steps']) {
      expect(sql.indexOf(`DROP CONSTRAINT "${name}"`)).toBeGreaterThan(-1);
      expect(sql.indexOf(`ADD CONSTRAINT "${name}"`)).toBeGreaterThan(sql.indexOf(`DROP CONSTRAINT "${name}"`));
    }
  });

  it('keeps people only on a change to the ownership step, and suggestions on the improvements step whatever the verdict', () => {
    expect(sql).toContain(`(jsonb_typeof("proposal") = 'object' AND "step" = 'ownership' AND "verdict" = 'needsChange')`);
    expect(sql).toContain(`(jsonb_typeof("proposal") = 'object' AND "step" = 'improvements' AND jsonb_typeof("proposal"->'suggestions') = 'array')`);
  });
});
