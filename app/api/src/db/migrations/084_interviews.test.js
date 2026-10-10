import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  ENTITY_KINDS, INTERVIEW_TYPES, PROPOSAL_KINDS, RESOLUTION_STATES, REVIEW_ACTIONS, STORAGE_POLICIES,
} from '../../interviews/contracts.js';
import { AUTOMATIC_STATES } from '../../interviews/resolution.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '084_interviews.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

/** The quoted values of `CHECK ("<column>" IN (...))`, for every occurrence of the column. */
function checkLists(column) {
  return [...statements.matchAll(new RegExp(`CHECK \\("${column}" IN \\(([^)]*)\\)\\)`, 'g'))]
    .map(m => [...m[1].matchAll(/'([^']+)'/g)].map(v => v[1]));
}

const TABLES = ['Interviews', 'InterviewMentions', 'InterviewResolutions', 'InterviewStatements', 'InterviewEvidence',
  'InterviewProposals', 'InterviewReviewDecisions', 'InterviewEvents'];

describe('migration 084 — interviews', () => {
  it('creates exactly the interview tables, and only those', () => {
    const created = [...statements.matchAll(/CREATE TABLE "(\w+)"/g)].map(m => m[1]);
    expect(created).toEqual(TABLES);
    expect(statements).not.toMatch(/ALTER TABLE/);
  });

  it('keeps every closed vocabulary identical to contracts.js', () => {
    expect(checkLists('interviewType')).toEqual([[...INTERVIEW_TYPES]]);
    expect(checkLists('storagePolicy')).toEqual([[...STORAGE_POLICIES]]);
    expect(checkLists('state')).toEqual([[...RESOLUTION_STATES]]);
    expect(checkLists('proposalKind')).toEqual([[...PROPOSAL_KINDS]]);
    expect(checkLists('action')).toEqual([[...REVIEW_ACTIONS]]);
    // entityKindHint on mentions, entityKind on resolutions.
    expect(checkLists('entityKindHint')).toEqual([[...ENTITY_KINDS]]);
    expect(checkLists('entityKind')).toEqual([[...ENTITY_KINDS]]);
  });

  it('lets the database itself refuse a detector that confirms', () => {
    const list = AUTOMATIC_STATES.map(s => `'${s}'`).join(',');
    expect(statements).toContain(`CHECK ("origin" = 'analyst' OR "state" IN (${list}))`);
  });

  it('references no canonical table — claims point at ids, they do not hang off rows a crawl may delete', () => {
    const targets = [...statements.matchAll(/REFERENCES "(\w+)"/g)].map(m => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every(t => t.startsWith('Interview'))).toBe(true);
  });

  it('makes every table except Interviews refuse UPDATE, and the audit trail refuse DELETE too', () => {
    const guarded = Object.fromEntries([...statements.matchAll(/BEFORE (UPDATE(?: OR DELETE)?) ON "(\w+)"/g)].map(m => [m[2], m[1]]));
    expect(guarded).toEqual({
      InterviewMentions: 'UPDATE', InterviewResolutions: 'UPDATE', InterviewStatements: 'UPDATE', InterviewEvidence: 'UPDATE',
      InterviewProposals: 'UPDATE', InterviewReviewDecisions: 'UPDATE', InterviewEvents: 'UPDATE OR DELETE',
    });
  });

  it('gives the audit trail no foreign key, so it outlives a deleted interview', () => {
    const events = statements.match(/CREATE TABLE "InterviewEvents" \(([\s\S]*?)\n\);/)[1];
    expect(events).not.toMatch(/REFERENCES/);
  });

  it('has no column that could hold audio or a whole transcript', () => {
    expect(statements).not.toMatch(/BYTEA|"audio|"transcript/i);
  });
});
