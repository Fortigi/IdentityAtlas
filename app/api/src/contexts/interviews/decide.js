// Context interviews — deciding a claim, and what a confirmed claim changes.
//
//   parseDecision(body)                     → the decision, or { error }
//   decideClaim(db, claimId, body, user)    → { claim, effect }   (throws ClaimError)
//
// Only a proposed claim can be decided. Rejected: nothing changes but the claim.
// Confirmed (or edited — confirmed with a changed value or period), by kind:
//
//   description  appended to the context's description under a heading
//                "From interview with <name>, <date>:" (once per interview: a
//                second description from it goes under the same heading)
//   property     extendedAttributes[attribute] = value
//   role         with a roleSuggestion: the ContextRole, addedBy 'analyst' (a person
//                decided) and sourceClaimId = this claim. Accountable: only when the
//                context has none, or the same person already holds it; another
//                holder answers 409 with the current one, and the caller confirms
//                again with replace: true. Responsible: added next to the others.
//                The claim must name its person first (principalId | identityId in
//                the body when the match was missing or wrong).
//   alias        added to extendedAttributes.aliases (an array; a spelling already
//                there is not added twice — lib/contextNameMatch.js), shown as
//                "Also known as" and tried when a name is matched to a context
//   role without a suggestion, roleHistory, membership
//                nothing beyond the claim: it is confirmed knowledge (What we know,
//                the role timeline, the members lists). A membership claim never
//                changes ContextMembers: members come from their source. A
//                claim never creates access.
//   a person claim that says they left, about a person the member list still
//                lists, confirmed as said ("the interview is right"): the person
//                is marked former by the decision (memberOverrides.js), on top of
//                ContextMembers — effect { kind: 'formerMember', overrides }
// All in one transaction. Decisions are recorded in _history (migration 097).
//
//   undoClaim(db, claimId)                  → { claim, unmarked }   (throws ClaimError)
//
// Undo puts a decided claim back to proposed (its contradiction opens again) and
// removes a former-member mark it made. Only a decision that changed nothing but
// the claim can be undone: any rejection, and a confirmed membership, roleHistory
// or role without a suggestion. A confirmed description, property, alias or role
// changed the context; undo that where it was changed.

import { ROLE_BEARING_CATEGORIES } from '../../lib/contextCategories.js';
import { periodDate, MAX_VALUE, MAX_PERIOD_TEXT } from './claims.js';
import * as store from './store.js';
import { mergeAliases } from '../../lib/contextNameMatch.js';
import { applyMemberOverride, clearClaimOverride } from './memberOverrides.js';

export class ClaimError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'ClaimError';
    this.status = status;
    this.details = details;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECISIONS = new Set(['confirmed', 'rejected', 'edited']);

function parseHolder(body) {
  const given = ['principalId', 'identityId'].filter(k => body[k] != null);
  if (given.length === 0) return { holder: null };
  if (given.length > 1) return { error: 'Give principalId or identityId, not both' };
  const id = String(body[given[0]]);
  if (!UUID_RE.test(id)) return { error: `${given[0]} must be a uuid` };
  return { holder: { col: given[0], id: id.toLowerCase() } };
}

function parsePeriod(body) {
  const out = {};
  for (const [key, end] of [['periodFrom', false], ['periodTo', true]]) {
    if (body[key] === undefined) continue;
    if (body[key] === null || body[key] === '') { out[key] = null; continue; }
    const d = periodDate(body[key], end);
    if (!d) return { error: `${key} must be a year, a year-month or a date` };
    out[key] = d;
  }
  if (body.periodText !== undefined) out.periodText = body.periodText ? String(body.periodText).trim().slice(0, MAX_PERIOD_TEXT) : null;
  return { period: out };
}

/** The body of PATCH /contexts/claims/:id → { status, value?, period, holder, replace } or { error }. Pure. */
export function parseDecision(body = {}) {
  if (!DECISIONS.has(body.status)) return { error: 'status must be confirmed, edited or rejected' };
  let value;
  if (body.value !== undefined) {
    value = typeof body.value === 'string' ? body.value.replace(/\s+/g, ' ').trim() : '';
    if (!value) return { error: 'value must be a non-empty text' };
    if (value.length > MAX_VALUE) return { error: `value is at most ${MAX_VALUE} characters` };
  }
  const p = parsePeriod(body);
  if (p.error) return { error: p.error };
  const h = parseHolder(body);
  if (h.error) return { error: h.error };
  return { status: body.status, value, period: p.period, holder: h.holder, replace: body.replace === true };
}

export const descriptionHeading = (name, date) => `From interview with ${name}, ${date}:`;

/** The description with `value` added under `heading` — the existing heading when it is the last section. Pure. */
export function appendDescription(current, heading, value) {
  const base = String(current ?? '').trimEnd();
  if (!base) return `${heading}\n${value}`;
  const lastSection = base.slice(base.lastIndexOf('\n\n') + 2);
  if (lastSection.startsWith(`${heading}\n`) || lastSection === heading) return `${base}\n${value}`;
  return `${base}\n\n${heading}\n${value}`;
}

const LOCK_SQL = `
  SELECT c.id, c."contextId", c."claimKind", c."principalId", c."identityId", c.attribute, c.value,
         c."periodFrom"::text AS "periodFrom", c."periodTo"::text AS "periodTo", c."periodText", c."roleSuggestion", c."claimStatus" AS status,
         iv."intervieweeName", iv."interviewedAt"::text AS "interviewedAt",
         ctx."contextCategory", ctx.description, ctx."extendedAttributes"->'aliases' AS "currentAliases"
    FROM "ContextClaims" c
    JOIN "ContextInterviews" iv ON iv.id = c."interviewId"
    JOIN "Contexts" ctx ON ctx.id = c."contextId"
   WHERE c.id = $1
     FOR UPDATE OF c`;

const HOLDER_TABLE = { principalId: 'Principals', identityId: 'Identities' };

async function applyRole(client, claim, holder, replace) {
  if (!ROLE_BEARING_CATEGORIES.has(claim.contextCategory)) {
    throw new ClaimError(400, 'Roles can only be set on an organizational unit or a logical application');
  }
  if (!holder) throw new ClaimError(400, 'Choose who this claim is about before confirming it');
  const found = (await client.query(`SELECT "displayName" FROM "${HOLDER_TABLE[holder.col]}" WHERE id = $1`, [holder.id])).rows[0];
  if (!found) throw new ClaimError(404, holder.col === 'principalId' ? 'Principal not found' : 'Identity not found');

  if (claim.roleSuggestion === 'Accountable') {
    const current = await store.currentAccountable(client, claim.contextId);
    const same = current && current[holder.col] === holder.id;
    if (current && !same && !replace) {
      throw new ClaimError(409, 'This context already has an Accountable', {
        current: { id: current.id, displayName: current.displayName, principalId: current.principalId, identityId: current.identityId },
      });
    }
    if (current && !same) await client.query(`DELETE FROM "ContextRoles" WHERE id = $1`, [current.id]);
  }
  const r = await client.query(`
    INSERT INTO "ContextRoles" ("contextId", "${holder.col}", role, "addedBy", "sourceClaimId")
    VALUES ($1, $2, $3, 'analyst', $4)
    ON CONFLICT ("contextId", "${holder.col}", role) WHERE "${holder.col}" IS NOT NULL
    DO UPDATE SET "sourceClaimId" = COALESCE("ContextRoles"."sourceClaimId", EXCLUDED."sourceClaimId"),
                  "updatedAt" = (now() AT TIME ZONE 'utc')
    RETURNING id`, [claim.contextId, holder.id, claim.roleSuggestion, claim.id]);
  return { kind: 'role', role: claim.roleSuggestion, roleId: r.rows[0].id, displayName: found.displayName };
}

async function applyEffect(client, claim, merged, holder, replace) {
  if (claim.claimKind === 'description') {
    const description = appendDescription(claim.description, descriptionHeading(claim.intervieweeName, claim.interviewedAt), merged.value);
    await client.query(`UPDATE "Contexts" SET description = $2 WHERE id = $1`, [claim.contextId, description]);
    return { kind: 'description' };
  }
  if (claim.claimKind === 'property') {
    await client.query(`
      UPDATE "Contexts" SET "extendedAttributes" = COALESCE("extendedAttributes", '{}'::jsonb) || jsonb_build_object($2::text, $3::text)
       WHERE id = $1`, [claim.contextId, claim.attribute, merged.value]);
    return { kind: 'property', attribute: claim.attribute };
  }
  if (claim.claimKind === 'alias') {
    const aliases = mergeAliases(claim.currentAliases, merged.value);
    await client.query(`
      UPDATE "Contexts" SET "extendedAttributes" = COALESCE("extendedAttributes", '{}'::jsonb) || jsonb_build_object('aliases', $2::jsonb)
       WHERE id = $1`, [claim.contextId, JSON.stringify(aliases)]);
    return { kind: 'alias', aliases };
  }
  if (claim.claimKind === 'role' && claim.roleSuggestion) return applyRole(client, claim, holder, replace);
  return { kind: 'none' };
}

const PERIOD_KEYS = ['periodFrom', 'periodTo', 'periodText'];

function claimHolder(claim) {
  if (claim.principalId) return { col: 'principalId', id: claim.principalId };
  if (claim.identityId) return { col: 'identityId', id: claim.identityId };
  return null;
}

/** The claim as decided: its value and period after the edits, whether they changed it, and its person. Pure. */
export function mergeDecision(claim, decision) {
  const merged = { value: decision.value ?? claim.value };
  for (const k of PERIOD_KEYS) merged[k] = k in decision.period ? decision.period[k] : claim[k];
  const edited = merged.value !== claim.value || PERIOD_KEYS.some(k => merged[k] !== claim[k]);
  return { merged, edited, holder: decision.holder ?? claimHolder(claim) };
}

/** Decide a claim. Returns { claim (as listed), effect }. */
export async function decideClaim(db, claimId, body, user) {
  if (!UUID_RE.test(String(claimId))) throw new ClaimError(400, 'Invalid ID format');
  const decision = parseDecision(body);
  if (decision.error) throw new ClaimError(400, decision.error);

  const effect = await db.tx(async (client) => {
    const claim = (await client.query(LOCK_SQL, [claimId])).rows[0];
    if (!claim) throw new ClaimError(404, 'Claim not found');
    if (claim.status !== 'proposed') throw new ClaimError(409, 'This claim has already been decided');

    const { merged, edited, holder } = mergeDecision(claim, decision);
    let status = 'rejected';
    let result = { kind: 'none' };
    if (decision.status !== 'rejected') {
      status = edited ? 'edited' : 'confirmed';
      result = await applyEffect(client, claim, merged, holder, decision.replace);
    }
    await client.query(`
      UPDATE "ContextClaims"
         SET "claimStatus" = $2, value = $3, "periodFrom" = $4::date, "periodTo" = $5::date, "periodText" = $6,
             "principalId" = $7, "identityId" = $8,
             "subjectMatch" = CASE WHEN $9 THEN 'key' ELSE "subjectMatch" END,
             "decidedBy" = $10, "decidedAt" = now()
       WHERE id = $1`,
    [claimId, status, merged.value, merged.periodFrom, merged.periodTo, merged.periodText,
      holder?.col === 'principalId' ? holder.id : null, holder?.col === 'identityId' ? holder.id : null,
      !!decision.holder, user]);
    const marked = await applyMemberOverride(client, claim, { status, merged, holder }, user);
    return marked && result.kind === 'none' ? { kind: 'formerMember', overrides: marked.overrides, changeRequest: marked.changeRequest } : result;
  });
  return { claim: await store.getClaimRow(db, claimId), effect };
}

const KNOWLEDGE_ONLY = new Set(['membership', 'roleHistory']);

/** Can this decided claim be undone? Its decision must have changed nothing but the claim. Pure. */
export function canUndo(claim) {
  if (claim.status === 'proposed') return false;
  if (claim.status === 'rejected') return true;
  return KNOWLEDGE_ONLY.has(claim.claimKind) || (claim.claimKind === 'role' && !claim.roleSuggestion);
}

/** Put a decided claim back to proposed, and remove the former-member mark it made. */
export async function undoClaim(db, claimId) {
  if (!UUID_RE.test(String(claimId))) throw new ClaimError(400, 'Invalid ID format');
  const unmarked = await db.tx(async (client) => {
    const claim = (await client.query(LOCK_SQL, [claimId])).rows[0];
    if (!claim) throw new ClaimError(404, 'Claim not found');
    if (claim.status === 'proposed') throw new ClaimError(409, 'This claim has not been decided');
    if (!canUndo(claim)) throw new ClaimError(409, 'This decision changed the context; change it there instead');
    const n = await clearClaimOverride(client, claimId);
    await client.query(`
      UPDATE "ContextClaims" SET "claimStatus" = 'proposed', "decidedBy" = NULL, "decidedAt" = NULL WHERE id = $1`, [claimId]);
    return n;
  });
  return { claim: await store.getClaimRow(db, claimId), unmarked: unmarked > 0 };
}
