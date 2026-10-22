// Contract test — the two access-review adoption reports against a real
// PostgreSQL schema.
//
// The unit tests hand the templates rows the SQL is supposed to produce; this
// file proves the SQL produces them: rounds folded per review instance, a
// decision the platform applied (all-zero reviewer) not counted as a person's,
// the governed intent+actual pair counted as one member, and the contacted
// reviewers read out of extendedAttributes.
//
// The database is shared with the other contract files, so every assertion is
// scoped to this file's own system (adoption) or its own reviewers (response).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import JSZip from 'jszip';
import { bootContractApp } from '../test-utils/contractApp.js';
import { asBinary } from '../test-utils/xlsxDownload.js';

const SYSTEM_NAME = 'contract-access-review-adoption';
const SYSTEM_REVIEWER = '00000000-0000-0000-0000-000000000000';

let agent;
let pool;
let systemId;

const people = { ann: randomUUID(), bob: randomUUID(), member: randomUUID() };
const roles = { reviewed: randomUUID(), auto: randomUUID(), none: randomUUID(), fresh: randomUUID() };
const DAY = 86400000;
const ago = days => new Date(Date.now() - days * DAY).toISOString();

async function decision(roleId, instanceId, endsDaysAgo, { reviewer, name, decision = 'Approve', contacted }) {
  await pool.query(
    `INSERT INTO "CertificationDecisions" ("id", "systemId", "resourceId", "principalId", "decision",
        "reviewedBy", "reviewedByDisplayName", "reviewedDateTime", "reviewInstanceId", "reviewInstanceStatus",
        "reviewInstanceEndDateTime", "extendedAttributes")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Completed', $10, $11::jsonb)`,
    [randomUUID(), systemId, roleId, people.member, decision, reviewer, name, ago(endsDaysAgo + 1), instanceId,
      ago(endsDaysAgo), JSON.stringify({ contactedReviewers: contacted.map(id => ({ id, displayName: 'x' })) })],
  );
}

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', $1) RETURNING "id"`, [SYSTEM_NAME],
  );
  systemId = sys.rows[0].id;

  for (const [key, id] of Object.entries(people)) {
    await pool.query(
      `INSERT INTO "Principals" ("id", "systemId", "displayName", "email", "principalType", "extendedAttributes")
       VALUES ($1, $2, $3, $4, 'User', '{}'::jsonb)`, [id, systemId, `CT ${key}`, `${key}@contract.example`]);
  }
  const role = (id, name, createdDaysAgo) => pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType", "createdDateTime")
     VALUES ($1, $2, $3, 'BusinessRole', $4)`, [id, systemId, name, ago(createdDaysAgo)]);
  await role(roles.reviewed, 'CT reviewed', 700);
  await role(roles.auto, 'CT auto-applied', 700);
  await role(roles.none, 'CT never reviewed', 700);
  await role(roles.fresh, 'CT brand new', 5);

  // The same member held twice — governed intent and actual — is one member.
  for (const governed of [false, true]) {
    await pool.query(
      `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "governed", "systemId")
       VALUES ($1, $2, 'Direct', $3, $4)`, [roles.reviewed, people.member, governed, systemId]);
  }

  // Reviewed: one round, Ann decided both items herself.
  const r1 = randomUUID();
  await decision(roles.reviewed, r1, 10, { reviewer: people.ann, name: 'CT ann', contacted: [people.ann] });
  await decision(roles.reviewed, r1, 10, { reviewer: people.ann, name: 'CT ann', decision: 'Deny', contacted: [people.ann] });
  // Auto-applied: two rounds Bob was asked to do; each closed by the platform.
  for (const days of [100, 20]) {
    await decision(roles.auto, randomUUID(), days, { reviewer: SYSTEM_REVIEWER, name: 'AAD Access Reviews', contacted: [people.bob] });
  }
});

afterAll(async () => {
  await pool.query(`DELETE FROM "CertificationDecisions" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('GET /reports/access-review-adoption/rows', () => {
  it('tells a review a person did from one the platform closed, and lists the never-reviewed and the new apart', async () => {
    const res = await agent.get('/api/reports/access-review-adoption/rows');
    expect(res.status).toBe(200);
    const rows = res.body.rows.filter(r => r.systemName === SYSTEM_NAME);
    const by = Object.fromEntries(rows.map(r => [r.businessRole, r]));

    expect(rows.map(r => r.businessRole)).toEqual(['CT never reviewed', 'CT auto-applied', 'CT reviewed', 'CT brand new']);
    expect(by['CT reviewed']).toMatchObject({
      status: 'Reviewed by a person', members: 1, reviews: 1, humanReviews: 1,
      latestReviewDecisions: 2, latestReviewByPerson: 2, lastHumanReviewer: 'CT ann', daysSinceHumanReview: 11,
      _entity: { kind: 'access-package', id: roles.reviewed },
    });
    expect(by['CT auto-applied']).toMatchObject({
      status: 'Never reviewed by a person', reviews: 2, humanReviews: 0, lastHumanReview: null,
      latestReviewDecisions: 1, latestReviewByPerson: 0, latestReviewNotByPerson: 1,
    });
    expect(by['CT never reviewed']).toMatchObject({ status: 'No review yet', reviews: 0 });
    expect(by['CT brand new']).toMatchObject({ status: 'New, no review yet' });
  });

  it('downloads a workbook with the charts tab', async () => {
    const res = await asBinary(agent.get('/api/reports/access-review-adoption/export?format=xlsx'));
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(res.body);
    expect(zip.file('xl/charts/chartReport1.xml')).toBeTruthy();
    expect(zip.file('xl/charts/chartReport2.xml')).toBeTruthy();
  });
});

describe('GET /reports/access-reviewer-response/rows', () => {
  it('reads who was asked from the decisions, and does not credit them with the platform\'s decisions', async () => {
    const res = await agent.get('/api/reports/access-reviewer-response/rows');
    expect(res.status).toBe(200);
    const mine = res.body.rows.filter(r => r.email?.endsWith('@contract.example'));
    const by = Object.fromEntries(mine.map(r => [r.reviewer, r]));

    expect(mine.map(r => r.reviewer)).toEqual(['CT bob', 'CT ann']);
    expect(by['CT bob']).toMatchObject({
      verdict: 'Never responded', roundsAsked: 2, roundsAnswered: 0, roundsMissed: 2, decisions: 0,
      department: null, _entity: { kind: 'user', id: people.bob },
    });
    expect(by['CT ann']).toMatchObject({
      verdict: 'Reviews consistently', roundsAsked: 1, roundsAnswered: 1, decisions: 2, approvedShare: 50, deniedShare: 50,
    });
    // The platform itself is never a reviewer.
    expect(res.body.rows.some(r => /access reviews/i.test(r.reviewer))).toBe(false);
  });
});
