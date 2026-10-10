// Interviews API — statements, evidence, revisions, proposals and the review gate.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../test-utils/routeTestKit.js';
import { scriptedDb } from '../../test-utils/scriptedDb.js';
import { excerptHash } from '../interviews/evidence.js';

vi.mock('../db/connection.js');

import { query } from '../db/connection.js';
import router from './interviews.js';

const IV = '3f1c2a9e-6b1d-4c2e-9a7b-1234567890ab';
const MENTION = '44444444-4444-4444-8444-444444444444';
const STATEMENT = '55555555-5555-4555-8555-555555555555';
const PROPOSAL = '66666666-6666-4666-8666-666666666666';
const EXCERPT = 'William beheert de productieomgeving';
const alice = { oid: 'alice', preferred_username: 'alice@example.org', permissions: new Set(['*']) };
const post = (path, body) => request(mountRouterAs(router, () => alice)).post(`/api/v1/interviews/${IV}${path}`).send(body);

const interviewRule = (policy = 'local-only') =>
  [/AS "expired" FROM "Interviews" WHERE "id" = \$1/, [{ id: IV, ownerKey: 'oid:alice', storagePolicy: policy, expired: false }]];
const mentionsRule = (ids = [MENTION]) => [/SELECT "id" FROM "InterviewMentions" WHERE "interviewId" = \$1/, ids.map(id => ({ id }))];
const okWrites = [[/INSERT INTO "InterviewStatements"/, []], [/INSERT INTO "InterviewEvidence"/, []], [/INSERT INTO "InterviewEvents"/, []]];
const CANONICAL = /"(Resources|ResourceAssignments|ResourceRelationships|Principals|Identities|IdentityMembers|Contexts|ContextMembers)"/;

const evidence = (over = {}) => ({ segmentId: 'seg-7', startMs: 61200, endMs: 64900, spanStart: 0, spanEnd: EXCERPT.length, excerptHash: excerptHash(EXCERPT), sttEngine: 'apple-speech@ios26', ...over });
const statement = (over = {}) => ({ subject: { mentionId: MENTION }, predicate: 'beheert', object: { literal: 'productieomgeving' }, claimConfidence: 0.7, extractor: 'rules@1', evidence: [evidence()], ...over });

beforeEach(() => {
  query.mockReset();
  process.env.FEATURE_INTERVIEWS = 'true';
});

describe('POST /v1/interviews/:id/statements', () => {
  it('stores the claim and the position + fingerprint of its evidence, and no words on a local-only interview', async () => {
    const db = scriptedDb(query, [interviewRule(), mentionsRule(), ...okWrites]);
    const res = await post('/statements', statement());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ version: 1, predicate: 'beheert' });
    expect(res.body.lineageId).toBe(res.body.id);
    const ev = db.calls.find(c => c.sql.includes('INSERT INTO "InterviewEvidence"'));
    expect(ev.params.slice(2)).toEqual(['seg-7', 61200, 64900, 0, EXCERPT.length, excerptHash(EXCERPT), null, 'apple-speech@ios26']);
    expect(res.body.evidence[0].excerptStored).toBe(false);
  });

  it('refuses excerpt text on a local-only interview, writing nothing', async () => {
    const db = scriptedDb(query, [interviewRule('local-only'), mentionsRule(), ...okWrites]);
    const res = await post('/statements', statement({ evidence: [evidence({ excerpt: EXCERPT })] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/local-only/);
    expect(db.writes()).toEqual([]);
  });

  it('keeps the excerpt on an evidence-excerpt interview once its hash checks out', async () => {
    const db = scriptedDb(query, [interviewRule('evidence-excerpt'), mentionsRule(), ...okWrites]);
    expect((await post('/statements', statement({ evidence: [evidence({ excerpt: EXCERPT })] }))).status).toBe(201);
    expect(db.calls.find(c => c.sql.includes('INSERT INTO "InterviewEvidence"')).params[8]).toBe(EXCERPT);
  });

  it('refuses a statement about a mention from another interview', async () => {
    const db = scriptedDb(query, [interviewRule(), mentionsRule([]), ...okWrites]);
    const res = await post('/statements', statement());
    expect(res.status).toBe(400);
    expect(db.writes()).toEqual([]);
  });
});

describe('revising a statement never overwrites its evidence', () => {
  const loadStatementRule = (version, latestVersion) =>
    [/FROM "InterviewStatements" s WHERE s."id" = \$1 AND s."interviewId" = \$2/, [{ id: STATEMENT, lineageId: STATEMENT, version, latestVersion }]];

  it('adds version 2 in the same lineage with its own evidence rows — only INSERTs, no UPDATE or DELETE', async () => {
    const db = scriptedDb(query, [interviewRule(), loadStatementRule(1, 1), mentionsRule(), ...okWrites]);
    const res = await post(`/statements/${STATEMENT}/revisions`, statement({ predicate: 'is eigenaar van', evidence: [evidence({ startMs: 70000, endMs: 72000 })] }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ lineageId: STATEMENT, version: 2, predicate: 'is eigenaar van' });
    expect(res.body.id).not.toBe(STATEMENT);
    expect(db.writes()).toEqual(['INSERT INTO "InterviewStatements"', 'INSERT INTO "InterviewEvidence"', 'INSERT INTO "InterviewEvents"']);
    const ins = db.calls.find(c => c.sql.includes('INSERT INTO "InterviewStatements"'));
    expect(ins.params.slice(2, 4)).toEqual([STATEMENT, 2]);
    // The new evidence row belongs to the NEW statement, not the original.
    const ev = db.calls.find(c => c.sql.includes('INSERT INTO "InterviewEvidence"'));
    expect(ev.params[1]).toBe(res.body.id);
    expect(db.calls.at(-1).params[1]).toBe('statement-revised');
  });

  it('refuses to revise an older version, so one claim cannot fork', async () => {
    const db = scriptedDb(query, [interviewRule(), loadStatementRule(1, 2)]);
    const res = await post(`/statements/${STATEMENT}/revisions`, statement());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Version 2 is the latest; revise that one');
    expect(db.writes()).toEqual([]);
  });

  it('answers 404 for a statement of another interview', async () => {
    scriptedDb(query, [interviewRule(), [/FROM "InterviewStatements" s WHERE s."id" = \$1/, []]]);
    expect((await post(`/statements/${STATEMENT}/revisions`, statement())).status).toBe(404);
  });
});

describe('proposals and the review gate', () => {
  it('proposes one statement version', async () => {
    const db = scriptedDb(query, [
      interviewRule(),
      [/FROM "InterviewStatements" s WHERE s."id" = \$1/, [{ id: STATEMENT, lineageId: STATEMENT, version: 3, latestVersion: 3 }]],
      [/INSERT INTO "InterviewProposals"/, []], [/INSERT INTO "InterviewEvents"/, []],
    ]);
    const res = await post('/proposals', { proposalKind: 'responsibility', statementId: STATEMENT, summary: 'William beheert productie' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ statementId: STATEMENT, statementVersion: 3, reviewState: 'proposed' });
    expect(db.writes()).toEqual(['INSERT INTO "InterviewProposals"', 'INSERT INTO "InterviewEvents"']);
  });

  it('refuses a proposal for a statement that is not in this interview', async () => {
    scriptedDb(query, [interviewRule(), [/FROM "InterviewStatements" s WHERE s."id" = \$1/, []]]);
    expect((await post('/proposals', { proposalKind: 'role', statementId: STATEMENT, summary: 'x' })).status).toBe(400);
  });

  const reviewRules = (state) => [
    interviewRule(),
    [/FROM "InterviewProposals" p JOIN "InterviewStatements" s/, state ? [{ id: PROPOSAL, ...state }] : []],
    [/INSERT INTO "InterviewReviewDecisions"/, (_s, p) => [{ id: 9, action: p[1], targetVersion: p[2], reviewer: p[4] }]],
    [/INSERT INTO "InterviewEvents"/, []],
  ];

  it('records an approval as a decision only: promoted is false and no canonical table is read or written', async () => {
    const db = scriptedDb(query, reviewRules({ proposalVersion: 1, latestVersion: 1, currentAction: null }));
    const res = await post(`/proposals/${PROPOSAL}/reviews`, { action: 'approve', targetVersion: 1, rationale: 'Bevestigd door manager' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ reviewState: 'approved', promoted: false, decision: { action: 'approve', targetVersion: 1, reviewer: 'oid:alice' } });
    expect(db.writes()).toEqual(['INSERT INTO "InterviewReviewDecisions"', 'INSERT INTO "InterviewEvents"']);
    expect(db.calls.some(c => CANONICAL.test(c.sql))).toBe(false);
  });

  it('refuses to approve a proposal whose statement was revised since — 409, nothing written', async () => {
    const db = scriptedDb(query, reviewRules({ proposalVersion: 1, latestVersion: 2, currentAction: null }));
    const res = await post(`/proposals/${PROPOSAL}/reviews`, { action: 'approve', targetVersion: 1 });
    expect(res.status).toBe(409);
    expect(db.writes()).toEqual([]);
  });

  it('refuses a second, contradicting decision on an approved proposal', async () => {
    const db = scriptedDb(query, reviewRules({ proposalVersion: 1, latestVersion: 1, currentAction: 'approve' }));
    expect((await post(`/proposals/${PROPOSAL}/reviews`, { action: 'reject', targetVersion: 1, rationale: 'toch niet' })).status).toBe(409);
    expect(db.writes()).toEqual([]);
  });

  it('needs an explicit review: no action, or no version read, is a 400 and writes nothing', async () => {
    const db = scriptedDb(query, reviewRules({ proposalVersion: 1, latestVersion: 1, currentAction: null }));
    expect((await post(`/proposals/${PROPOSAL}/reviews`, { targetVersion: 1 })).status).toBe(400);
    expect((await post(`/proposals/${PROPOSAL}/reviews`, { action: 'approve' })).status).toBe(400);
    expect(db.writes()).toEqual([]);
    expect(db.calls.some(c => c.sql.includes('"InterviewProposals"'))).toBe(false);
  });

  it('answers 404 for a proposal of another interview', async () => {
    scriptedDb(query, reviewRules(null));
    expect((await post(`/proposals/${PROPOSAL}/reviews`, { action: 'defer', targetVersion: 1 })).status).toBe(404);
  });
});
