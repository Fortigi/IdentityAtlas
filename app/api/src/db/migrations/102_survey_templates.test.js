// Static checks on migration 102. What the feature writes into it is verified
// against PostgreSQL in contract-tests/surveyTemplates.contract.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CATEGORIES } from '../../contexts/surveys/service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '102_survey_templates.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
const inList = (column, from = statements) => from.match(new RegExp(`"${column}" IN \\(([^)]+)\\)`))[1].split(',').map(s => s.trim().replace(/'/g, ''));

describe('migration 102 — survey templates', () => {
  it('creates three tables, extends the interview tables, and writes no rows', () => {
    expect(statements.match(/CREATE TABLE "(\w+)"/g)).toEqual(['CREATE TABLE "SurveyTemplates"', 'CREATE TABLE "SurveyTemplateVersions"', 'CREATE TABLE "SurveyRequests"']);
    expect([...new Set(statements.match(/ALTER TABLE "(\w+)"/g))]).toEqual(['ALTER TABLE "ContextInterviews"', 'ALTER TABLE "ContextClaims"']);
    expect(statements).not.toMatch(/DELETE FROM|UPDATE "|INSERT INTO|DROP TABLE|DROP COLUMN/);
  });

  it('a template is for the categories a survey can be sent about', () => {
    expect(inList('contextCategory')).toEqual(CATEGORIES);
  });

  it('a request is answered against the exact version it was sent with, and goes with its context', () => {
    expect(statements).toMatch(/FOREIGN KEY \("templateId", "templateVersion"\)\s+REFERENCES "SurveyTemplateVersions"\("templateId", "version"\)/);
    expect(statements).toMatch(/"contextId"\s+UUID NOT NULL REFERENCES "Contexts"\("id"\)\s+ON DELETE CASCADE/);
    expect(inList('status')).toEqual(['sent', 'submitted', 'cancelled']);
    expect(statements).toMatch(/"ck_SurveyRequests_one_recipient" CHECK \("principalId" IS NULL OR "identityId" IS NULL\)/);
  });

  it('a survey answer is an interview whose claims the respondent proposed; a claim may be about a resource', () => {
    expect(statements).toMatch(/ADD COLUMN "surveyRequestId" UUID REFERENCES "SurveyRequests"\("id"\) ON DELETE SET NULL/);
    expect(statements).toMatch(/ADD COLUMN "resourceId" UUID REFERENCES "Resources"\("id"\) ON DELETE SET NULL/);
    expect(inList('proposedBy')).toEqual(['model', 'analyst', 'respondent']);
    expect(inList('subjectKind')).toEqual(['Context', 'Person', 'Resource']);
  });

  it('records a request\'s status and due date in _history, not every saved draft', () => {
    expect(statements).toMatch(/AFTER INSERT OR DELETE ON "SurveyRequests"/);
    expect(statements).toMatch(/WHEN \(OLD\."status" IS DISTINCT FROM NEW\."status" OR OLD\."dueAt" IS DISTINCT FROM NEW\."dueAt"\)/);
  });
});
