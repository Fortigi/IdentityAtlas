import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { INTERVALS, MIN_DUE_DAYS, MAX_DUE_DAYS } from '../../lib/reviewCampaignSchedule.js';
import { ASKED_ROLE } from '../../lib/reviewCampaigns.js';

// The steps as migration 121 allowed them; migration 122 added the improvements step.
const STEPS = ['ownership', 'lifecycle', 'contents'];

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, '121_review_campaigns.sql'), 'utf8').replace(/^\s*--.*$/gm, '');
const jsonList = (values) => `'[${values.map(v => `"${v}"`).join(', ')}]'::jsonb`;

describe('migration 121 — review campaigns', () => {
  it('lets a campaign ask exactly the steps a review knows, and at least one', () => {
    expect(sql).toContain(`CHECK (jsonb_typeof("steps") = 'array' AND jsonb_array_length("steps") >= 1 AND "steps" <@ ${jsonList(STEPS)})`);
  });

  it('asks the Accountable only, by default and by rule', () => {
    expect(sql).toContain(`"askedRoles"     JSONB NOT NULL DEFAULT ${jsonList([ASKED_ROLE])}`);
    expect(sql).toContain(`jsonb_array_length("askedRoles") >= 1 AND "askedRoles" <@ ${jsonList([ASKED_ROLE])}`);
  });

  it('repeats on the intervals the schedule knows, or not at all, with a term in range', () => {
    expect(sql).toContain(`"intervalMonths" IS NULL OR "intervalMonths" IN (${INTERVALS.join(', ')})`);
    expect(sql).toContain(`"dueDays" BETWEEN ${MIN_DUE_DAYS} AND ${MAX_DUE_DAYS}`);
  });

  it('scopes a campaign by a business role or a role portfolio, never both in one row, each once', () => {
    expect(sql).toContain('CHECK (num_nonnulls("resourceId", "contextId") = 1)');
    expect(sql).toMatch(/UNIQUE INDEX "uq_ReviewCampaignScopes_role" ON "ReviewCampaignScopes" \("campaignId", "resourceId"\) WHERE "resourceId" IS NOT NULL/);
    expect(sql).toMatch(/UNIQUE INDEX "uq_ReviewCampaignScopes_portfolio" ON "ReviewCampaignScopes" \("campaignId", "contextId"\) WHERE "contextId" IS NOT NULL/);
  });

  it('numbers the rounds of a campaign once each, and asks about a role once per round', () => {
    expect(sql).toContain('UNIQUE ("campaignId", "number")');
    expect(sql).toContain('UNIQUE ("roundId", "resourceId")');
  });

  it('removes scope and requests with the role or portfolio, and everything with the campaign', () => {
    expect(sql.match(/REFERENCES "ReviewCampaigns"\("id"\) ON DELETE CASCADE/g)).toHaveLength(2);
    expect(sql.match(/REFERENCES "Resources"\("id"\) ON DELETE CASCADE/g)).toHaveLength(2);
    expect(sql).toContain('REFERENCES "Contexts"("id") ON DELETE CASCADE');
    expect(sql).toContain('REFERENCES "ReviewCampaignRounds"("id") ON DELETE CASCADE');
  });

  it('keeps a request when its review goes, as unanswered', () => {
    expect(sql).toContain('"reviewId"   UUID REFERENCES "BusinessRoleCompositionReviews"("id") ON DELETE SET NULL');
  });
});
