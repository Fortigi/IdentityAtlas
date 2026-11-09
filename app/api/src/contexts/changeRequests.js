// Change requests — what should change in the source (migration 103).
// Design: docs/architecture/change-requests.md.
//
//   summaryFor(request)                                  → "Remove Led from Klanten"            (pure)
//   targetOf(context)                                    → { systemId, name } | null              (pure)
//   parseFilters(query)                                  → { status, systemId, contextId }       (pure, throws ChangeRequestError)
//   raiseForOverride(client, { contextId, memberId, claimId, overrideId }, user) → request | null
//   withdrawForMember(client, contextId, memberId, reason) → rows withdrawn
//   withdrawForClaim(client, claimId, reason)            → rows withdrawn
//   reconcile(db)                                        → rows resolved
//   listChangeRequests(db, filters)                      → { items, counts }
//
// An override changes what Identity Atlas shows; a change request says what
// should change in the source it overrides. Raised in the same transaction as the
// override, only when there is a source to correct: a context synced from a
// system or an uploaded list. A unit kept by hand is owned by Identity Atlas
// itself, and a rule's output is fixed in the rule's input, which this slice
// cannot name yet — neither gets one.
//
// Nobody closes a request by hand. reconcile() runs before every read and
// resolves each open request whose change the data now shows; undoing the
// decision withdraws it.

export const CHANGE_KINDS = Object.freeze(['EntityCreate', 'EntityDelete', 'RelationshipAdd', 'RelationshipRemove', 'AttributeUpdate']);
export const CHANGE_STATUSES = Object.freeze(['open', 'resolved', 'withdrawn']);

export const REASONS = Object.freeze({
  notListed: 'The source no longer lists them',
  unitGone: 'The source no longer has this unit',
  undone: 'The decision was undone',
  backInUnit: 'A later decision says they are in the unit',
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ChangeRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** One line a person can act on. Pure. */
export function summaryFor(r) {
  const who = r.memberName || 'the member';
  const unit = r.contextName || 'the unit';
  switch (r.changeKind) {
    case 'RelationshipRemove': return `Remove ${who} from ${unit}`;
    case 'RelationshipAdd': return `Add ${who} to ${unit}`;
    case 'EntityCreate': return `Create ${unit}`;
    case 'EntityDelete': return `Delete ${unit}`;
    case 'AttributeUpdate': return `Set ${r.attribute || 'the attribute'} of ${unit} to ${r.expectedValue || '(empty)'}`;
    default: throw new ChangeRequestError(400, `Unknown change kind: ${r.changeKind}`);
  }
}

/** The source a context's member list can be corrected in, or null. Pure. */
export function targetOf(context) {
  if (!context || context.variant !== 'synced' || !context.scopeSystemId) return null;
  return { systemId: context.scopeSystemId, name: context.systemName || `System ${context.scopeSystemId}` };
}

/** ?status=&systemId=&contextId=, checked. Pure. */
export function parseFilters(query = {}) {
  const out = { status: null, systemId: null, contextId: null };
  if (query.status) {
    if (!CHANGE_STATUSES.includes(query.status)) throw new ChangeRequestError(400, `status must be one of ${CHANGE_STATUSES.join(', ')}`);
    out.status = query.status;
  }
  if (query.systemId) {
    const id = Number(query.systemId);
    if (!Number.isInteger(id) || id <= 0) throw new ChangeRequestError(400, 'systemId must be a positive integer');
    out.systemId = id;
  }
  if (query.contextId) {
    if (!UUID_RE.test(String(query.contextId))) throw new ChangeRequestError(400, 'Invalid contextId');
    out.contextId = query.contextId;
  }
  return out;
}

// The context, its source, and the member's name by the kind of member it holds.
export const RAISE_CONTEXT_SQL = `
    SELECT ctx."displayName", ctx.variant, ctx."scopeSystemId", s."displayName" AS "systemName",
           COALESCE(p."displayName", i."displayName") AS "memberName"
      FROM "Contexts" ctx
      LEFT JOIN "Systems" s ON s.id = ctx."scopeSystemId"
      LEFT JOIN "Principals" p ON ctx."targetType" = 'Principal' AND p.id = $2::uuid
      LEFT JOIN "Identities" i ON ctx."targetType" = 'Identity' AND i.id = $2::uuid
     WHERE ctx.id = $1`;

export const FIND_OPEN_SQL = `
    SELECT id FROM "ChangeRequests"
     WHERE "requestStatus" = 'open' AND "changeKind" = $1 AND "targetSystemId" = $2 AND "contextId" = $3 AND "memberId" = $4`;

const RETURNING = `RETURNING id, "changeKind", "targetSystemId", "targetName", "contextId", "contextName", "memberId", "memberName",
              summary, "requestStatus" AS status, "basisClaimId", "overrideId", "raisedBy", "raisedAt"`;

export const UPDATE_OPEN_SQL = `
    UPDATE "ChangeRequests"
       SET "basisClaimId" = $2, "overrideId" = $3, "raisedBy" = $4, "raisedAt" = now(),
           "targetName" = $5, "contextName" = $6, "memberName" = $7, summary = $8
     WHERE id = $1
    ${RETURNING}`;

export const INSERT_SQL = `
    INSERT INTO "ChangeRequests"
      ("changeKind", "targetSystemId", "targetName", "contextId", "contextName", "memberId", "memberName",
       summary, "basisClaimId", "overrideId", "raisedBy")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ${RETURNING}`;

/**
 * A member marked former by a decision: ask the source to stop listing them.
 * Inside the decision's transaction. Null when the context has no source to
 * correct. Deciding it again updates the open request instead of adding one.
 */
export async function raiseForOverride(client, { contextId, memberId, claimId, overrideId = null }, user) {
  const context = (await client.query(RAISE_CONTEXT_SQL, [contextId, memberId])).rows[0];
  const target = targetOf(context);
  if (!target) return null;
  const changeKind = 'RelationshipRemove';
  const names = { contextName: context.displayName, memberName: context.memberName ?? null };
  const summary = summaryFor({ changeKind, ...names });
  const open = (await client.query(FIND_OPEN_SQL, [changeKind, target.systemId, contextId, memberId])).rows[0];
  if (open) {
    return (await client.query(UPDATE_OPEN_SQL,
      [open.id, claimId, overrideId, user ?? null, target.name, names.contextName, names.memberName, summary])).rows[0];
  }
  return (await client.query(INSERT_SQL,
    [changeKind, target.systemId, target.name, contextId, names.contextName, memberId, names.memberName,
      summary, claimId, overrideId, user ?? null])).rows[0];
}

export const WITHDRAW_MEMBER_SQL = `
    UPDATE "ChangeRequests" SET "requestStatus" = 'withdrawn', "closedAt" = now(), "closedReason" = $3
     WHERE "requestStatus" = 'open' AND "contextId" = $1 AND "memberId" = $2`;
export const WITHDRAW_CLAIM_SQL = `
    UPDATE "ChangeRequests" SET "requestStatus" = 'withdrawn', "closedAt" = now(), "closedReason" = $2
     WHERE "requestStatus" = 'open' AND "basisClaimId" = $1`;

/** A later decision put the member back: withdraw what was raised about them. */
export async function withdrawForMember(client, contextId, memberId, reason = REASONS.backInUnit) {
  return (await client.query(WITHDRAW_MEMBER_SQL, [contextId, memberId, reason])).rowCount ?? 0;
}

/** The decision a request rests on was undone. */
export async function withdrawForClaim(client, claimId, reason = REASONS.undone) {
  return (await client.query(WITHDRAW_CLAIM_SQL, [claimId, reason])).rowCount ?? 0;
}

// The source shows the change: the unit is gone, or it no longer lists the member.
export const RESOLVE_SQL = `
    UPDATE "ChangeRequests" r
       SET "requestStatus" = 'resolved', "closedAt" = now(),
           "closedReason" = CASE WHEN r."contextId" IS NULL THEN $1 ELSE $2 END
     WHERE r."requestStatus" = 'open' AND r."changeKind" = 'RelationshipRemove'
       AND (r."contextId" IS NULL
            OR NOT EXISTS (SELECT 1 FROM "ContextMembers" cm
                            WHERE cm."contextId" = r."contextId" AND cm."memberId" = r."memberId"))`;

/** Resolve every open request the data now shows done. */
export async function reconcile(db) {
  return (await db.query(RESOLVE_SQL, [REASONS.unitGone, REASONS.notListed])).rowCount ?? 0;
}

export const LIST_SQL = `
    SELECT r.id, r."changeKind", r."targetSystemId", r."targetName", r."contextId", r."contextName",
           r."memberId", r."memberName", r.attribute, r."currentValue", r."expectedValue", r.summary, r."requestStatus" AS status,
           r."basisClaimId", r."overrideId", r."raisedBy", r."raisedAt", r."closedAt", r."closedReason"
      FROM "ChangeRequests" r
     WHERE ($1::text IS NULL OR r."requestStatus" = $1)
       AND ($2::int  IS NULL OR r."targetSystemId" = $2)
       AND ($3::uuid IS NULL OR r."contextId" = $3)
     ORDER BY (r."requestStatus" = 'open') DESC, r."raisedAt" DESC
     LIMIT 500`;

export const COUNTS_SQL = `
    SELECT "requestStatus" AS status, count(*)::int AS n FROM "ChangeRequests"
     WHERE ($1::int IS NULL OR "targetSystemId" = $1) AND ($2::uuid IS NULL OR "contextId" = $2)
     GROUP BY "requestStatus"`;

/** The requests, after closing the ones the data shows done; with a count per status. */
export async function listChangeRequests(db, filters = {}) {
  const { status = null, systemId = null, contextId = null } = filters;
  await reconcile(db);
  const items = (await db.query(LIST_SQL, [status, systemId, contextId])).rows;
  const counts = Object.fromEntries(CHANGE_STATUSES.map(s => [s, 0]));
  for (const row of (await db.query(COUNTS_SQL, [systemId, contextId])).rows) counts[row.status] = row.n;
  return { items, counts };
}
