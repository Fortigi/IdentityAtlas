// Composition reviews of a business role (migrations 116 and 120). A review is
// an object of its own, linked to the role: who reviewed it, when, a verdict per
// step (lib/compositionReviewSteps.js), their closing notes, and a snapshot of
// the role as it was at that moment (lib/businessRoleSnapshot.js), so a later
// reader sees exactly what was reviewed and what changed since. Rows are never
// updated, and a review changes nothing about the role: a proposed owner is a
// proposal.

import * as db from '../db/connection.js';
import { likeContains } from '../db/sqlParams.js';
import { takeSnapshot, compareSnapshots } from './businessRoleSnapshot.js';
import {
  STEPS, VERDICTS, OWNERSHIP, orderSteps, outcomeOf, ownersOfSnapshot, sameOwners, unexplainedChange,
} from './compositionReviewSteps.js';

export const HISTORY_LIMIT = 50;
export const PEOPLE_LIMIT = 10;
export const MIN_PEOPLE_SEARCH = 2;

export const REVIEWS_SQL = `
    SELECT r.id, r.notes, r."reviewedBy", r."reviewedByName", r."reviewedAt", r.snapshot,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
                              'step', s.step, 'verdict', s.verdict, 'remark', s.remark, 'proposal', s.proposal))
                       FROM "BusinessRoleCompositionReviewSteps" s
                      WHERE s."reviewId" = r.id), '[]'::jsonb) AS steps
      FROM "BusinessRoleCompositionReviews" r
     WHERE r."resourceId" = $1
     ORDER BY r."reviewedAt" DESC, r.id
     LIMIT ${HISTORY_LIMIT}`;

export const INSERT_REVIEW_SQL = `
    INSERT INTO "BusinessRoleCompositionReviews" ("resourceId", notes, "reviewedBy", "reviewedByName", snapshot)
    VALUES ($1, $2, $3, $4, $5::jsonb)
    RETURNING id, notes, "reviewedBy", "reviewedByName", "reviewedAt", snapshot`;

export const INSERT_STEP_SQL = `
    INSERT INTO "BusinessRoleCompositionReviewSteps" ("reviewId", step, verdict, remark, proposal)
    VALUES ($1, $2, $3, $4, $5::jsonb)`;

// The names a proposal stores are the directory's own, never the request's.
export const PRINCIPAL_NAMES_SQL = `SELECT id, "displayName" FROM "Principals" WHERE id = ANY($1::uuid[]) AND "deletedAt" IS NULL`;
export const IDENTITY_NAMES_SQL = `SELECT id, "displayName" FROM "Identities" WHERE id = ANY($1::uuid[])`;

// People a reviewer can propose as an owner: live user accounts by name or
// e-mail, a short list, and nothing about them but who they are.
export const PEOPLE_SQL = `
    SELECT u.id, u."displayName", u.email AS "userPrincipalName"
      FROM "Principals" u
     WHERE u."deletedAt" IS NULL AND u."principalType" = 'User'
       AND (u."displayName" ILIKE $1 ESCAPE '\\' OR u.email ILIKE $1 ESCAPE '\\')
     ORDER BY u."displayName", u.id
     LIMIT ${PEOPLE_LIMIT}`;

/** One stored review as the API gives it: steps in order, and what it found. */
export function presentReview(row) {
  const steps = orderSteps(row.steps ?? []);
  return { ...row, steps, outcome: outcomeOf(steps) };
}

/**
 * The reviews, newest first; the role as it is now; the latest review with what
 * changed since; and the steps and verdicts a review can have. `latestReview`
 * is null while nobody has reviewed the role. Pure.
 */
export function reviewSummary(rows, current) {
  const reviews = rows.map(presentReview);
  const latest = reviews[0] ?? null;
  return {
    reviews,
    current,
    latestReview: latest ? { ...latest, changesSince: compareSnapshots(latest.snapshot, current) } : null,
    steps: STEPS,
    verdicts: VERDICTS,
  };
}

export async function loadCompositionReviews(roleId, { pool = db, snapshot = takeSnapshot } = {}) {
  const [reviews, current] = await Promise.all([pool.query(REVIEWS_SQL, [roleId]), snapshot(roleId)]);
  return reviewSummary(reviews.rows, current);
}

async function namesById(pool, sql, ids) {
  if (ids.length === 0) return new Map();
  const { rows } = await pool.query(sql, [ids]);
  return new Map(rows.map(r => [String(r.id).toLowerCase(), r.displayName]));
}

/**
 * The proposal with every person's name from the directory, or null when one of
 * them is not in it (a made-up id, or an account deleted in the source).
 */
export async function resolveProposal(proposal, { pool = db } = {}) {
  const people = [proposal.accountable, ...proposal.responsible].filter(Boolean);
  const [principals, identities] = await Promise.all([
    namesById(pool, PRINCIPAL_NAMES_SQL, people.map(p => p.principalId).filter(Boolean)),
    namesById(pool, IDENTITY_NAMES_SQL, people.map(p => p.identityId).filter(Boolean)),
  ]);
  const named = (p) => {
    const names = p.principalId ? principals : identities;
    const id = p.principalId ?? p.identityId;
    return names.has(id) ? { ...p, displayName: names.get(id) ?? null } : null;
  };
  const accountable = proposal.accountable ? named(proposal.accountable) : null;
  const responsible = proposal.responsible.map(named);
  if ((proposal.accountable && !accountable) || responsible.includes(null)) return null;
  return { accountable, responsible };
}

// The ownership step with its proposal resolved against the directory and the
// role as it is now. A proposal that names the people who answer for the role
// already proposes nothing, and is dropped.
async function settleStep(step, picture, pool) {
  if (step.step !== OWNERSHIP || !step.proposal) return step;
  if (sameOwners(step.proposal, ownersOfSnapshot(picture))) return { ...step, proposal: null };
  const proposal = await resolveProposal(step.proposal, { pool });
  return proposal ? { ...step, proposal } : null;
}

async function settleSteps(steps, picture, pool) {
  const out = [];
  for (const step of steps) {
    const settled = await settleStep(step, picture, pool);
    if (!settled) return { error: 'Choose the people from the list: one of them is not in the directory any more' };
    out.push(settled);
  }
  if (unexplainedChange(out)) return { error: 'Say what should change, or choose the people it should be' };
  return { steps: out };
}

/**
 * Saves one review — its steps in the same transaction — with a snapshot of the
 * role right now. Returns the review as the API gives it, or { error } when a
 * step asks for a change without saying which.
 */
export async function saveCompositionReview(roleId, { steps, notes }, { by, byName }, { pool = db, snapshot = takeSnapshot, tx = db.tx } = {}) {
  const picture = await snapshot(roleId);
  const settled = await settleSteps(steps, picture, pool);
  if (settled.error) return settled;
  const saved = await tx(async (client) => {
    const { rows } = await client.query(INSERT_REVIEW_SQL, [roleId, notes, by, byName ?? null, JSON.stringify(picture)]);
    for (const s of settled.steps) {
      await client.query(INSERT_STEP_SQL, [rows[0].id, s.step, s.verdict, s.remark, s.proposal ? JSON.stringify(s.proposal) : null]);
    }
    return rows[0];
  });
  return presentReview({ ...saved, steps: settled.steps });
}

/** Up to PEOPLE_LIMIT people matching the term; none for a term too short to mean anyone. */
export async function searchPeople(term, { pool = db } = {}) {
  const t = String(term ?? '').trim();
  if (t.length < MIN_PEOPLE_SEARCH) return [];
  const { rows } = await pool.query(PEOPLE_SQL, [likeContains(t)]);
  return rows;
}
