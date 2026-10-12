// Integration test — knowledge extraction end to end on real PostgreSQL 16.
//
// The whole flow through the real app and the real SQL: upload the synthetic demo
// interview (tools/knowledge-extraction/fixtures, demo-dataset names only), extract
// it with the deterministic fake model (tools/knowledge-extraction/fake-model.mjs —
// the pipeline's mechanics, not the model's quality), resolve the mentions against
// seeded identities, groups and an imported customer list, review, re-run, export.
//
// What only the real database proves: the partial unique indexes that make a re-run
// idempotent, ON CONFLICT targets matching them, the analyst-decision guards, the
// evidence offsets against the stored text, the cascade on delete.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createFakeModel } from '../../../tools/knowledge-extraction/fake-model.mjs';
import { bootContractApp } from '../test-utils/contractApp.js';

const FIXTURE = fileURLToPath(new URL('../../../tools/knowledge-extraction/fixtures/demo-interview.nl.txt', import.meta.url));
const TEXT = readFileSync(FIXTURE, 'utf8');

let agent;
let pool;
let fake;
let systemId;
let sourceId;
const ids = {
  anna: randomUUID(), tom: randomUUID(), hassan: randomUUID(), maria: randomUUID(), mariaAcc: randomUUID(),
  sgFinance: randomUUID(), listSource: randomUUID(), northwind: randomUUID(), victor: randomUUID(), victorAcc: randomUUID(), tier0: randomUUID(),
};

async function waitForRun(runId) {
  for (let i = 0; i < 100; i++) {
    const r = await agent.get(`/api/org-truth/knowledge/runs/${runId}`);
    if (['completed', 'failed', 'cancelled'].includes(r.body.status)) return r.body;
    await new Promise(res => setTimeout(res, 100));
  }
  throw new Error('extraction run did not finish');
}

async function extract() {
  const res = await agent.post(`/api/org-truth/knowledge/sources/${sourceId}/extract`).send({});
  expect(res.status).toBe(202);
  const run = await waitForRun(res.body.id);
  expect(run.error ?? null).toBeNull();
  expect(run.status).toBe('completed');
  return run;
}

beforeAll(async () => {
  fake = await createFakeModel();
  process.env.ORG_KNOWLEDGE_LLM_URL = fake.url;
  process.env.FEATURE_ORG_INFO = 'true';
  process.env.FEATURE_KNOWLEDGE_EXTRACTION = 'true';
  ({ agent, pool } = await bootContractApp());

  systemId = (await pool.query(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'knowledge-demo') RETURNING "id"`)).rows[0].id;
  for (const [id, name] of [[ids.anna, 'Anna Bakker'], [ids.tom, 'Tom Bakker'], [ids.hassan, 'Hassan Ibrahim'], [ids.maria, 'Maria Novak']]) {
    await pool.query(`INSERT INTO "Identities" ("id", "displayName") VALUES ($1, $2)`, [id, name]);
  }
  await pool.query(`INSERT INTO "Principals" ("id", "systemId", "displayName", "email", "principalType") VALUES ($1, $2, 'Maria Novak', 'maria@demo.example', 'User')`, [ids.mariaAcc, systemId]);
  await pool.query(`INSERT INTO "IdentityMembers" ("identityId", "principalId") VALUES ($1, $2)`, [ids.maria, ids.mariaAcc]);
  await pool.query(`INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType") VALUES ($1, $2, 'SG-Finance', 'Group')`, [ids.sgFinance, systemId]);
  // Victor IS in SG-Admin-Tier0: the directory confirms what the interview says about him
  await pool.query(`INSERT INTO "Identities" ("id", "displayName") VALUES ($1, 'Victor Wang')`, [ids.victor]);
  await pool.query(`INSERT INTO "Principals" ("id", "systemId", "displayName", "email", "principalType") VALUES ($1, $2, 'Victor Wang', 'victor@demo.example', 'User')`, [ids.victorAcc, systemId]);
  await pool.query(`INSERT INTO "IdentityMembers" ("identityId", "principalId") VALUES ($1, $2)`, [ids.victor, ids.victorAcc]);
  await pool.query(`INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType") VALUES ($1, $2, 'SG-Admin-Tier0', 'Group')`, [ids.tier0, systemId]);
  await pool.query(`INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "principalType", "systemId") VALUES ($1, $2, 'Direct', 'User', $3)`, [ids.tier0, ids.victorAcc, systemId]);
  // an imported customer list (Org Info), the thing a customer mention must find
  await pool.query(`INSERT INTO "OrgSources" ("id", "kind", "displayName", "observedAt") VALUES ($1, 'list', 'Klanten', now())`, [ids.listSource]);
  await pool.query(`INSERT INTO "OrgEntities" ("id", "entityType", "displayName", "sourceId", "origin", "status", "observedAt")
                    VALUES ($1, 'Klant', 'Northwind Traders', $2, 'import', 'accepted', now())`, [ids.northwind, ids.listSource]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM "OrgSources" WHERE "id" = ANY($1::uuid[])`, [[ids.listSource, sourceId].filter(Boolean)]);
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "IdentityMembers" WHERE "identityId" = ANY($1::uuid[])`, [[ids.maria, ids.victor]]);
  await pool.query(`DELETE FROM "Identities" WHERE "id" = ANY($1::uuid[])`, [[ids.anna, ids.tom, ids.hassan, ids.maria, ids.victor]]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  await fake.close();
  delete process.env.USE_SQL;
  delete process.env.ORG_KNOWLEDGE_LLM_URL;
  delete process.env.FEATURE_KNOWLEDGE_EXTRACTION;
});

describe('knowledge extraction on the demo interview', () => {
  it('stores the transcript once, with passages whose offsets slice the stored text', async () => {
    const first = await agent.post('/api/org-truth/knowledge/sources').send({ text: TEXT, displayName: 'Demo interview', speaker: 'Anna Bakker', observedAt: '2026-10-11' });
    expect(first.status).toBe(201);
    sourceId = first.body.id;
    const again = await agent.post('/api/org-truth/knowledge/sources').send({ text: TEXT });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: sourceId, duplicate: true });
    const detail = (await agent.get(`/api/org-truth/knowledge/sources/${sourceId}`)).body;
    expect(detail.metadata).toMatchObject({ language: 'nl', speaker: 'Anna Bakker', format: 'text' });
    expect(detail.passages.length).toBeGreaterThanOrEqual(8);
    for (const p of detail.passages) expect(detail.textContent.slice(p.startChar, p.endChar)).toBe(p.text);
    // a transcript is not a list: the Org Info sources list leaves it out
    expect((await agent.get('/api/org-truth/sources')).body.some(s => s.id === sourceId)).toBe(false);
  });

  it('extracts statements whose every quote is the source text at its offsets', async () => {
    const run = await extract();
    expect(run.stats).toMatchObject({ model: 'fake-knowledge-model', mode: 'pipeline' });
    expect(run.stats.written.claims).toBeGreaterThanOrEqual(10);
    const { textContent } = (await agent.get(`/api/org-truth/knowledge/sources/${sourceId}`)).body;
    const claims = (await agent.get(`/api/org-truth/knowledge/sources/${sourceId}/claims`)).body;
    const said = claims.map(c => `${c.subject.label} ${c.predicate} ${c.object.label}`);
    expect(said).toEqual(expect.arrayContaining([
      'Maria Novak memberOf SG-Finance', 'Hassan Ibrahim worksForCustomer Northwind Traders',
      'Piet Jansen worksForCustomer Contoso Retail', 'Rachel Smith worksForCustomer Contoso Retail', 'Grace Huang leads Security Team',
    ]));
    for (const c of claims) {
      expect(c.evidence.length).toBeGreaterThan(0);
      for (const e of c.evidence) expect(textContent.slice(e.startChar, e.endChar)).toBe(e.quote);
    }
    // the injected instruction in the transcript produced nothing
    expect(said.some(s => /beheerder|iedereen/i.test(s))).toBe(false);
    expect(claims.find(c => c.modality === 'correction')).toMatchObject({ predicate: 'hasProperty', object: { label: 'vijf mensen' } });
  });

  it('matches mentions to real objects, keeps the two Bakkers ambiguous and an unknown customer unmatched', async () => {
    const mentions = (await agent.get(`/api/org-truth/knowledge/sources/${sourceId}/mentions`)).body;
    const by = (label) => mentions.find(m => m.label === label);
    expect(by('Northwind Traders').candidates[0]).toMatchObject({ targetType: 'OrgEntity', targetId: ids.northwind, label: 'Northwind Traders' });
    expect(by('SG-Finance').candidates[0]).toMatchObject({ targetType: 'Resource', targetId: ids.sgFinance });
    expect(by('Maria Novak').candidates.map(c => c.targetId)).toEqual(expect.arrayContaining([ids.maria, ids.mariaAcc]));
    expect(by('Bakker').resolution).toBe('ambiguous');
    expect(by('Bakker').candidates.slice(0, 2).map(c => c.targetId).sort()).toEqual([ids.anna, ids.tom].sort());
    expect(by('Wingtip Partners')).toMatchObject({ resolution: 'unmatched', candidates: [] });
    for (const m of mentions) for (const c of m.candidates) expect(c.status).toBe('proposed');
  });

  it('raises review questions — the directory gap, the ambiguous and the unknown name — never a verdict', async () => {
    const findings = (await agent.get(`/api/org-truth/knowledge/sources/${sourceId}/findings`)).body;
    const categories = findings.map(f => f.category);
    expect(categories).toEqual(expect.arrayContaining(['directory-gap', 'ambiguous-name', 'unresolved-name', 'self-correction', 'model']));
    expect(findings.find(f => f.category === 'directory-gap').text).toContain('Maria Novak is geen lid van de groep "SG-Finance"');
    expect(findings.every(f => f.status === 'open')).toBe(true);
  });

  it('reviews a match and a statement independently; a stale decision is refused', async () => {
    const maria = (await agent.get(`/api/org-truth/knowledge/sources/${sourceId}/mentions`)).body.find(m => m.label === 'Maria Novak');
    const identityLink = maria.candidates.find(c => c.targetId === ids.maria);
    const confirmed = await agent.put(`/api/org-truth/knowledge/matches/${identityLink.linkId}`).send({ action: 'confirm' });
    expect(confirmed.body.link).toMatchObject({ status: 'accepted', analystOverride: 'confirmed' });

    const claim = (await agent.get(`/api/org-truth/knowledge/sources/${sourceId}/claims`)).body.find(c => c.subject.label === 'Maria Novak');
    const ok = await agent.put(`/api/org-truth/knowledge/claims/${claim.id}`).send({ status: 'accepted', expectedStatus: 'proposed' });
    expect(ok.body).toMatchObject({ status: 'accepted' });
    const stale = await agent.put(`/api/org-truth/knowledge/claims/${claim.id}`).send({ status: 'rejected', expectedStatus: 'proposed' });
    expect(stale.status).toBe(409);

    const about = (await agent.get(`/api/org-truth/knowledge/statements?targetType=Identity&targetId=${ids.maria}`)).body;
    expect(about.map(s => s.text)).toEqual(['Maria Novak is a member of SG-Finance']);
    expect(about[0]).toMatchObject({ sourceName: 'Demo interview', quote: expect.stringContaining('Maria Novak zit in de groep SG-Finance') });
  });

  it('scores every statement against the data: the directory confirms Victor, contradicts Maria', async () => {
    const claims = (await agent.get(`/api/org-truth/knowledge/sources/${sourceId}/claims`)).body;
    const victor = claims.find(c => c.subject.label === 'Victor Wang' && c.object.label === 'SG-Admin-Tier0');
    expect(victor.corroboration).toEqual({ verdict: 'corroborated', kind: 'directory', detail: 'member of the group "SG-Admin-Tier0"' });
    expect(victor.confidence).toBeGreaterThanOrEqual(80);
    expect(victor.band).toBe('high');
    const maria = claims.find(c => c.subject.label === 'Maria Novak');
    expect(maria.corroboration.verdict).toBe('contradicted');
    expect(maria.confidence).toBeLessThanOrEqual(25);
    for (const c of claims) expect(c.confidence).toBeGreaterThanOrEqual(0);
  });

  it('accepts a whole confidence group at once, and never flips a decided statement', async () => {
    const claims = (await agent.get(`/api/org-truth/knowledge/sources/${sourceId}/claims?status=proposed`)).body;
    const high = claims.filter(c => c.band === 'high').map(c => c.id);
    expect(high.length).toBeGreaterThan(0);
    const res = await agent.put(`/api/org-truth/knowledge/sources/${sourceId}/claims/bulk`).send({ status: 'accepted', ids: high });
    expect(res.body).toMatchObject({ status: 'accepted', updated: high.length });
    const again = await agent.put(`/api/org-truth/knowledge/sources/${sourceId}/claims/bulk`).send({ status: 'rejected', ids: high });
    expect(again.body.updated).toBe(0);
  });

  it('a renamed mention changes everywhere and keeps the transcript spelling', async () => {
    const m = (await agent.get(`/api/org-truth/knowledge/sources/${sourceId}/mentions`)).body.find(x => x.label === 'Fortigi Demo');
    const res = await agent.put(`/api/org-truth/knowledge/mentions/${m.id}`).send({ label: 'Fortigi Demo Corp', type: 'organisation' });
    expect(res.body.mention).toMatchObject({ label: 'Fortigi Demo Corp', type: 'organisation', originalLabel: 'Fortigi Demo' });
  });

  it('serves the original file, and a restricted transcript can still be downloaded by whoever may see it', async () => {
    const orig = await agent.get(`/api/org-truth/knowledge/sources/${sourceId}/original`);
    expect(orig.status).toBe(200);
    expect(orig.text).toBe(TEXT);
    const secret = await agent.post('/api/org-truth/knowledge/sources').send({ text: 'Een vertrouwelijk gesprek over iets anders.', classification: 'restricted' });
    expect(secret.status).toBe(201);
    // auth is off in the contract app, so everyone may see it — the refusal itself is unit-tested
    expect((await agent.get(`/api/org-truth/sources/${secret.body.id}/download`)).status).toBe(200);
    await agent.delete(`/api/org-truth/sources/${secret.body.id}`);
  });

  it('a second run adds nothing and keeps every decision', async () => {
    const before = (await agent.get(`/api/org-truth/knowledge/sources/${sourceId}/claims`)).body;
    const run = await extract();
    expect(run.stats.pipeline.cached).toBeGreaterThan(0); // resumed from the first run's answers
    const after = (await agent.get(`/api/org-truth/knowledge/sources/${sourceId}/claims`)).body;
    expect(after.map(c => c.id).sort()).toEqual(before.map(c => c.id).sort());
    expect(after.find(c => c.subject.label === 'Maria Novak').status).toBe('accepted');
    const mentions = (await agent.get(`/api/org-truth/knowledge/sources/${sourceId}/mentions`)).body;
    const maria = mentions.find(m => m.label === 'Maria Novak');
    expect(maria.candidates.find(c => c.targetId === ids.maria)).toMatchObject({ status: 'accepted', analystOverride: 'confirmed' });
    // the reviewer's name survived the re-run; the transcript's spelling did not come back
    expect(mentions.find(m => m.label === 'Fortigi Demo Corp')).toMatchObject({ type: 'organisation', originalLabel: 'Fortigi Demo' });
    expect(mentions.some(m => m.label === 'Fortigi Demo')).toBe(false);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "OrgEntities" WHERE "sourceId" = $1`, [sourceId]);
    expect(rows[0].n).toBe((await agent.get(`/api/org-truth/knowledge/sources/${sourceId}/mentions`)).body.length);
  });

  it('keeps transcript mentions out of the Org Info review queue', async () => {
    const review = (await agent.get('/api/org-truth/review?status=proposed')).body;
    expect(review.rows.some(r => String(r.entity.entityType).startsWith('Mentioned '))).toBe(false);
  });

  it('exports everything with versions, and deleting the source removes it all', async () => {
    const pkg = (await agent.get(`/api/org-truth/knowledge/sources/${sourceId}/export`)).body;
    expect(pkg).toMatchObject({ schemaVersion: '0.1', externalAiUsed: false, source: { id: sourceId } });
    expect(pkg.claims.length).toBeGreaterThan(0);
    expect(pkg.runs).toHaveLength(2);
    const del = await agent.delete(`/api/org-truth/sources/${sourceId}`);
    expect(del.status).toBe(200);
    const { rows } = await pool.query(`SELECT
      (SELECT count(*) FROM "OrgEntities" WHERE "sourceId" = $1)::int AS e,
      (SELECT count(*) FROM "OrgClaimEvidence" WHERE "sourceId" = $1)::int AS ev,
      (SELECT count(*) FROM "OrgKnowledgeFindings" WHERE "sourceId" = $1)::int AS f`, [sourceId]);
    expect(rows[0]).toEqual({ e: 0, ev: 0, f: 0 });
    sourceId = null;
  });
});
