// Composition reviews of a business role (migration 116): somebody reads what
// the role contains, writes notes and, when they agree, signs it off. Every save
// is kept, with who saved it and what the role contained at that moment, so a
// later reader can see what was signed off and what changed since.

import * as db from '../db/connection.js';

export const MAX_NOTES = 10_000;
export const HISTORY_LIMIT = 50;

// What the role contains now: its live resources, as the Resources tab and the
// Resources count show them (a resource deleted in the source is history).
export const CURRENT_COMPOSITION_SQL = `
    SELECT DISTINCT rrs."childResourceId" AS id,
           COALESCE(r."displayName", rrs."roleName") AS "displayName"
      FROM "ResourceRelationships" rrs
      LEFT JOIN "Resources" r ON r.id = rrs."childResourceId"
     WHERE rrs."parentResourceId" = $1 AND rrs."relationshipType" = 'Contains'
       AND r."deletedAt" IS NULL
     ORDER BY "displayName", id`;

export const REVIEWS_SQL = `
    SELECT id, notes, "signedOff", "reviewedBy", "reviewedByName", "reviewedAt", composition
      FROM "BusinessRoleCompositionReviews"
     WHERE "resourceId" = $1
     ORDER BY "reviewedAt" DESC, id
     LIMIT ${HISTORY_LIMIT}`;

export const INSERT_REVIEW_SQL = `
    INSERT INTO "BusinessRoleCompositionReviews" ("resourceId", notes, "signedOff", "reviewedBy", "reviewedByName", composition)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    RETURNING id, notes, "signedOff", "reviewedBy", "reviewedByName", "reviewedAt", composition`;

/**
 * { notes, signedOff } from a request body, or { error } when it says nothing,
 * is too long, or is not the right shape. Pure.
 */
export function parseReviewBody(body) {
  const notes = typeof body?.notes === 'string' ? body.notes.trim() : '';
  if (body?.notes !== undefined && typeof body.notes !== 'string') return { error: 'notes must be text' };
  if (body?.signedOff !== undefined && typeof body.signedOff !== 'boolean') return { error: 'signedOff must be true or false' };
  if (notes.length > MAX_NOTES) return { error: `notes can be at most ${MAX_NOTES} characters` };
  const signedOff = body?.signedOff === true;
  if (!signedOff && notes === '') return { error: 'Write a note or sign off' };
  return { notes, signedOff };
}

/** What was added to and removed from the role since `signedOff` (a composition), by name. Pure. */
export function changesSince(signedOff = [], current = []) {
  const before = new Set(signedOff.map(r => r.id));
  const now = new Set(current.map(r => r.id));
  return {
    added: current.filter(r => !before.has(r.id)).map(r => r.displayName),
    removed: signedOff.filter(r => !now.has(r.id)).map(r => r.displayName),
  };
}

/**
 * The reviews, newest first, and the latest sign-off with what changed since.
 * `latestSignOff` is null while nobody has signed the role off. Pure.
 */
export function reviewSummary(reviews, current) {
  const latest = reviews.find(r => r.signedOff) || null;
  return {
    reviews,
    current: current.length,
    latestSignOff: latest ? { ...latest, changesSince: changesSince(latest.composition, current) } : null,
  };
}

export async function loadCompositionReviews(roleId, pool = db) {
  const [reviews, current] = await Promise.all([
    pool.query(REVIEWS_SQL, [roleId]),
    pool.query(CURRENT_COMPOSITION_SQL, [roleId]),
  ]);
  return reviewSummary(reviews.rows, current.rows);
}

/** Saves one review with the role's composition right now. */
export async function saveCompositionReview(roleId, { notes, signedOff }, { by, byName }, pool = db) {
  const current = (await pool.query(CURRENT_COMPOSITION_SQL, [roleId])).rows;
  const { rows } = await pool.query(INSERT_REVIEW_SQL, [roleId, notes, signedOff, by, byName ?? null, JSON.stringify(current)]);
  return rows[0];
}
