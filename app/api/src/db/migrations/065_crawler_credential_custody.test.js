import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '065_crawler_credential_custody.sql'), 'utf8');
const statements = sql.replace(/^--.*$/gm, '').split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
const find = (re) => statements.find(s => re.test(s));

// Text-level guard, mirroring 054's / 058's / 061's (SEC-2026-09 H-02, M-06).
describe('migration 065 — crawler credential custody', () => {
  it('adds a nullable CrawlerJobs.configId that follows config deletion', () => {
    expect(find(/^ALTER TABLE "CrawlerJobs" ADD COLUMN "configId" INTEGER REFERENCES "CrawlerConfigs" \("id"\) ON DELETE SET NULL$/)).toBeDefined();
  });

  it('backfills configId only from a numeric id naming an existing config of the same type, for jobs without their own secret', () => {
    const backfill = find(/^UPDATE "CrawlerJobs" j SET "configId"/);
    expect(backfill).toBeDefined();
    expect(backfill).toContain(`WHERE j."configId" IS NULL`);
    expect(backfill).toContain(`(j."config"->>'_scheduledByConfigId') ~ '^[0-9]{1,9}$'`);
    expect(backfill).toContain(`c."id" = (j."config"->>'_scheduledByConfigId')::int`);
    expect(backfill).toContain(`c."crawlerType" = j."jobType"`);
    expect(backfill).toContain(`NOT EXISTS ( SELECT 1 FROM "Secrets" s WHERE s."id" = 'crawler-job:' || j."id" || ':clientSecret' )`);
  });

  it('indexes the configId lookup the scheduler de-duplication uses', () => {
    expect(find(/^CREATE INDEX "ix_CrawlerJobs_configId" ON "CrawlerJobs" \("configId", "createdAt" DESC\)$/)).toBeDefined();
  });

  it('adds Crawlers.isBuiltIn defaulting to false', () => {
    expect(find(/^ALTER TABLE "Crawlers" ADD COLUMN "isBuiltIn" BOOLEAN NOT NULL DEFAULT FALSE$/)).toBeDefined();
  });

  it('flags exactly one existing worker, preferring the bootstrap-created, enabled, oldest row', () => {
    const flag = find(/^UPDATE "Crawlers" SET "isBuiltIn" = TRUE/);
    expect(flag).toBeDefined();
    expect(flag).toContain(`WHERE "displayName" = 'Built-in Worker'`);
    expect(flag).toMatch(/ORDER BY \("createdBy" = 'system-bootstrap'\) DESC NULLS LAST, "enabled" DESC, "id" ASC LIMIT 1/);
  });

  it('allows at most one built-in row', () => {
    expect(find(/^CREATE UNIQUE INDEX "ux_Crawlers_isBuiltIn" ON "Crawlers" \("isBuiltIn"\) WHERE "isBuiltIn"$/)).toBeDefined();
  });
});
