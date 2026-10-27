// Authorization workbench — saved investigations (M2a), the SQL.
// Design: docs/architecture/m1-discovery-and-design.md, "M2a — save and reopen".
// Tables: migration 107. The shape of what is saved: investigationDraft.js.
//
// A save holds the whole draft: the view, the snapshot of the cells on screen,
// every mark and every proposed role. What the save leaves out is removed — a
// mark cleared, a proposed role deleted. A mark that did not change keeps who
// made it and when; a proposed role keeps its id. Org-wide, like saved matrices:
// every analyst can open, save and delete every investigation.
//
// Nothing here writes a Resource, an assignment, a member or a claim.

import { InvestigationError, parseDraft, personKeyOf } from './investigationDraft.js';

const notFound = () => new InvestigationError(404, 'Investigation not found');

const LIST_SQL = `
  SELECT w.id, w.name, w.description, w."accessReadAt", w."createdBy", w."createdAt", w."updatedBy", w."updatedAt",
         (SELECT count(*) FROM "WorkbenchMarks" m WHERE m."investigationId" = w.id)::int AS "markCount",
         COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', p.name) ORDER BY p.position, p."createdAt", p.id)
                     FROM "RoleProposals" p WHERE p."investigationId" = w.id), '[]'::json) AS proposals
    FROM "WorkbenchInvestigations" w
   WHERE w."contextId" = $1
   ORDER BY w."updatedAt" DESC, w.id`;

const HEAD_SQL = `
  SELECT id, "contextId", name, description, view, "accessReadAt", "createdBy", "createdAt", "updatedBy", "updatedAt"
    FROM "WorkbenchInvestigations" WHERE id = $1`;

const MARKS_SQL = `
  SELECT "personKind", "personId", "resourceId", mark, note, "markedBy", "markedAt"
    FROM "WorkbenchMarks" WHERE "investigationId" = $1 ORDER BY "markedAt", "personId", "resourceId"`;

const PROPOSALS_SQL = `
  SELECT p.id, p.name, p.description, p.mode, p."baseBusinessRoleId", p.status, p.version,
         p."createdBy", p."createdAt", p."updatedBy", p."updatedAt",
         COALESCE((SELECT array_agg(m."personKind" || ':' || m."personId" ORDER BY m."personKind", m."personId")
                     FROM "RoleProposalMembers" m WHERE m."proposalId" = p.id), '{}') AS members,
         COALESCE((SELECT array_agg(e."resourceId" ORDER BY e."resourceId")
                     FROM "RoleProposalEntitlements" e WHERE e."proposalId" = p.id), '{}') AS entitlements,
         COALESCE((SELECT array_agg(v."claimId" ORDER BY v."claimId")
                     FROM "RoleProposalEvidence" v WHERE v."proposalId" = p.id), '{}') AS "evidenceClaimIds"
    FROM "RoleProposals" p WHERE p."investigationId" = $1
   ORDER BY p.position, p."createdAt", p.id`;

/** The saved investigations of a unit, newest first, with their proposed roles' names. */
export async function listInvestigations(db, contextId) {
  return (await db.query(LIST_SQL, [contextId])).rows;
}

const personKeyFromStored = (stored) => {
  const [kind, id] = stored.split(':');
  return personKeyOf(kind, id);
};

/** One investigation, everything a reopen needs. */
export async function getInvestigation(db, id) {
  const head = await db.queryOne(HEAD_SQL, [id]);
  if (!head) throw notFound();
  const [marks, proposals, snapshot] = await Promise.all([
    db.query(MARKS_SQL, [id]),
    db.query(PROPOSALS_SQL, [id]),
    db.queryOne(`SELECT cells FROM "WorkbenchAccessSnapshots" WHERE "investigationId" = $1`, [id]),
  ]);
  return {
    ...head,
    marks: marks.rows.map(m => ({
      person: personKeyOf(m.personKind, m.personId), resourceId: m.resourceId, mark: m.mark, note: m.note, markedBy: m.markedBy, markedAt: m.markedAt,
    })),
    proposals: proposals.rows.map(p => ({ ...p, members: p.members.map(personKeyFromStored) })),
    accessCells: snapshot?.cells ?? [],
  };
}

// ─── writes (inside one transaction; `client` is a pg client) ─────────────

async function writeSnapshot(client, id, cells) {
  await client.query(
    `INSERT INTO "WorkbenchAccessSnapshots" ("investigationId", cells) VALUES ($1, $2::jsonb)
     ON CONFLICT ("investigationId") DO UPDATE SET cells = EXCLUDED.cells`, [id, JSON.stringify(cells)]);
}

const markColumns = (marks) => [
  marks.map(m => m.personKind), marks.map(m => m.personId), marks.map(m => m.resourceId), marks.map(m => m.mark), marks.map(m => m.note),
];

export const DELETE_CLEARED_MARKS_SQL = `
  DELETE FROM "WorkbenchMarks" w
   WHERE w."investigationId" = $1
     AND NOT EXISTS (SELECT 1 FROM unnest($2::text[], $3::uuid[], $4::uuid[]) AS t(k, p, r)
                      WHERE t.k = w."personKind" AND t.p = w."personId" AND t.r = w."resourceId")`;

// An unchanged mark keeps its author and time; a changed one gets the saver's.
export const UPSERT_MARKS_SQL = `
  INSERT INTO "WorkbenchMarks" ("investigationId", "personKind", "personId", "resourceId", mark, note, "markedBy")
  SELECT $1, t.k, t.p, t.r, t.m, t.n, $7
    FROM unnest($2::text[], $3::uuid[], $4::uuid[], $5::text[], $6::text[]) AS t(k, p, r, m, n)
  ON CONFLICT ("investigationId", "personKind", "personId", "resourceId") DO UPDATE
     SET mark = EXCLUDED.mark, note = EXCLUDED.note, "markedBy" = EXCLUDED."markedBy", "markedAt" = now()
   WHERE ("WorkbenchMarks".mark, "WorkbenchMarks".note) IS DISTINCT FROM (EXCLUDED.mark, EXCLUDED.note)`;

async function writeMarks(client, id, marks, actor) {
  const [kinds, persons, resources, values, notes] = markColumns(marks);
  await client.query(DELETE_CLEARED_MARKS_SQL, [id, kinds, persons, resources]);
  if (marks.length) await client.query(UPSERT_MARKS_SQL, [id, kinds, persons, resources, values, notes, actor]);
}

// A base role that no longer exists is dropped rather than refused.
const BASE_ROLE_SQL = `(SELECT r.id FROM "Resources" r WHERE r.id = $5::uuid)`;

// Its place in the list moves without counting as a change to the proposal.
export const UPDATE_PROPOSAL_SQL = `
  UPDATE "RoleProposals"
     SET name = $3, description = $4, "baseBusinessRoleId" = ${BASE_ROLE_SQL}, mode = $6, "updatedBy" = $7, "updatedAt" = now()
   WHERE id = $1 AND "investigationId" = $2
     AND (name, description, "baseBusinessRoleId", mode) IS DISTINCT FROM ($3, $4, ${BASE_ROLE_SQL}, $6)`;

export const POSITION_SQL = `UPDATE "RoleProposals" SET position = $2 WHERE id = $1 AND position IS DISTINCT FROM $2`;

export const INSERT_PROPOSAL_SQL = `
  INSERT INTO "RoleProposals" (id, "investigationId", name, description, "baseBusinessRoleId", mode, "createdBy", "updatedBy", position)
  VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, ${BASE_ROLE_SQL}, $6, $7, $7, $8)
  RETURNING id`;

/**
 * The id a proposal is saved under: its own when it is already this
 * investigation's, the browser's when that id is new, a fresh one when the id
 * belongs to another investigation (an id from the browser never moves another
 * investigation's proposal).
 */
async function saveProposalRow(client, investigationId, p, actor, existing, position) {
  const params = [p.id, investigationId, p.name, p.description, p.baseBusinessRoleId, p.mode, actor];
  if (p.id && existing.has(p.id)) {
    await client.query(UPDATE_PROPOSAL_SQL, params);
    await client.query(POSITION_SQL, [p.id, position]);
    return p.id;
  }
  const taken = p.id ? (await client.query(`SELECT 1 FROM "RoleProposals" WHERE id = $1`, [p.id])).rowCount > 0 : false;
  const row = (await client.query(INSERT_PROPOSAL_SQL, [taken ? null : p.id, ...params.slice(1), position])).rows[0];
  return row.id;
}

async function writeProposalParts(client, proposalId, p) {
  await client.query(`DELETE FROM "RoleProposalMembers" WHERE "proposalId" = $1`, [proposalId]);
  await client.query(`DELETE FROM "RoleProposalEntitlements" WHERE "proposalId" = $1`, [proposalId]);
  await client.query(`DELETE FROM "RoleProposalEvidence" WHERE "proposalId" = $1`, [proposalId]);
  if (p.members.length) {
    await client.query(`INSERT INTO "RoleProposalMembers" ("proposalId", "personKind", "personId")
      SELECT $1, k, id FROM unnest($2::text[], $3::uuid[]) AS t(k, id)`, [proposalId, p.members.map(m => m.personKind), p.members.map(m => m.personId)]);
  }
  if (p.entitlements.length) {
    await client.query(`INSERT INTO "RoleProposalEntitlements" ("proposalId", "resourceId")
      SELECT $1, r FROM unnest($2::uuid[]) AS r`, [proposalId, p.entitlements]);
  }
  // A claim deleted since it was cited is left out rather than refused.
  if (p.evidenceClaimIds.length) {
    await client.query(`INSERT INTO "RoleProposalEvidence" ("proposalId", "claimId")
      SELECT $1, c FROM unnest($2::uuid[]) AS c WHERE EXISTS (SELECT 1 FROM "ContextClaims" x WHERE x.id = c)`, [proposalId, p.evidenceClaimIds]);
  }
}

async function writeProposals(client, investigationId, proposals, actor) {
  const existing = new Set((await client.query(`SELECT id FROM "RoleProposals" WHERE "investigationId" = $1`, [investigationId])).rows.map(r => r.id));
  const kept = [];
  for (const [position, p] of proposals.entries()) {
    const id = await saveProposalRow(client, investigationId, p, actor, existing, position);
    await writeProposalParts(client, id, p);
    kept.push(id);
  }
  await client.query(`DELETE FROM "RoleProposals" WHERE "investigationId" = $1 AND NOT (id = ANY($2::uuid[]))`, [investigationId, kept]);
}

async function writeContent(client, id, draft, actor) {
  await writeSnapshot(client, id, draft.accessCells);
  await writeMarks(client, id, draft.marks, actor);
  await writeProposals(client, id, draft.proposals, actor);
}

const nameTaken = (err) => err?.code === '23505'
  ? new InvestigationError(409, 'This unit already has an investigation with that name.') : err;

async function assertUnit(db, contextId) {
  const unit = await db.queryOne(`SELECT "contextCategory" FROM "Contexts" WHERE id = $1`, [contextId]);
  if (!unit) throw new InvestigationError(404, 'Context not found');
  if (unit.contextCategory !== 'OrganizationalUnit') throw new InvestigationError(400, 'An investigation is saved on an organizational unit.');
}

/** Save a new investigation on a unit. */
export async function createInvestigation(db, contextId, body, actor) {
  const draft = parseDraft(body, { requireName: true });
  await assertUnit(db, contextId);
  let id;
  try {
    id = await db.tx(async (client) => {
      const row = (await client.query(
        `INSERT INTO "WorkbenchInvestigations" ("contextId", name, description, view, "accessReadAt", "createdBy", "updatedBy")
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6) RETURNING id`,
        [contextId, draft.name, draft.description ?? null, JSON.stringify(draft.view), draft.accessReadAt, actor])).rows[0];
      await writeContent(client, row.id, draft, actor);
      return row.id;
    });
  } catch (err) { throw nameTaken(err); }
  return getInvestigation(db, id);
}

// Saved over only when nobody else saved it since it was opened (expectedUpdatedAt,
// compared to the millisecond the browser was given).
export const UPDATE_HEAD_SQL = `
  UPDATE "WorkbenchInvestigations"
     SET name = COALESCE($2, name), description = CASE WHEN $3::boolean THEN $4 ELSE description END,
         view = $5::jsonb, "accessReadAt" = $6, "updatedBy" = $7, "updatedAt" = now()
   WHERE id = $1 AND ($8::timestamptz IS NULL OR date_trunc('milliseconds', "updatedAt") = $8::timestamptz)
  RETURNING id`;

/** Save over an investigation: the whole draft replaces what was saved. */
export async function saveInvestigation(db, id, body, actor) {
  const draft = parseDraft(body, { requireName: false });
  try {
    await db.tx(async (client) => {
      const updated = await client.query(UPDATE_HEAD_SQL, [
        id, draft.name ?? null, draft.description !== undefined, draft.description ?? null,
        JSON.stringify(draft.view), draft.accessReadAt, actor, draft.expectedUpdatedAt]);
      if (updated.rowCount === 0) {
        const row = (await client.query(`SELECT "updatedBy" FROM "WorkbenchInvestigations" WHERE id = $1`, [id])).rows[0];
        if (!row) throw notFound();
        throw new InvestigationError(409, `${row.updatedBy} saved this investigation after you opened it. Save it under another name, or open it again.`);
      }
      await writeContent(client, id, draft, actor);
    });
  } catch (err) { throw nameTaken(err); }
  return getInvestigation(db, id);
}

/** Delete an investigation with its marks and proposed roles. */
export async function deleteInvestigation(db, id) {
  const r = await db.query(`DELETE FROM "WorkbenchInvestigations" WHERE id = $1`, [id]);
  if (r.rowCount === 0) throw notFound();
}

/** Delete one proposed role of an investigation; the others stay. */
export async function deleteProposal(db, investigationId, proposalId) {
  const r = await db.query(`DELETE FROM "RoleProposals" WHERE id = $1 AND "investigationId" = $2`, [proposalId, investigationId]);
  if (r.rowCount === 0) throw new InvestigationError(404, 'Proposed role not found');
}
