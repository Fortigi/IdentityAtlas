// Composition reviews of a business role (migration 116). A review is an object
// of its own, linked to the role: who reviewed it, when, their notes, whether
// they signed it off, and a snapshot of the role as it was at that moment
// (lib/businessRoleSnapshot.js), so a later reader sees exactly what was
// reviewed and what changed since. Rows are never updated.

import * as db from '../db/connection.js';
import { takeSnapshot, compareSnapshots } from './businessRoleSnapshot.js';

export const MAX_NOTES = 10_000;
export const HISTORY_LIMIT = 50;

export const REVIEWS_SQL = `
    SELECT id, notes, "signedOff", "reviewedBy", "reviewedByName", "reviewedAt", snapshot
      FROM "BusinessRoleCompositionReviews"
     WHERE "resourceId" = $1
     ORDER BY "reviewedAt" DESC, id
     LIMIT ${HISTORY_LIMIT}`;

export const INSERT_REVIEW_SQL = `
    INSERT INTO "BusinessRoleCompositionReviews" ("resourceId", notes, "signedOff", "reviewedBy", "reviewedByName", snapshot)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    RETURNING id, notes, "signedOff", "reviewedBy", "reviewedByName", "reviewedAt", snapshot`;

/**
 * { notes, signedOff } from a request body, or { error } when it says nothing,
 * is too long, or is not the right shape. Pure.
 */
export function parseReviewBody(body) {
  if (body?.notes !== undefined && typeof body.notes !== 'string') return { error: 'notes must be text' };
  if (body?.signedOff !== undefined && typeof body.signedOff !== 'boolean') return { error: 'signedOff must be true or false' };
  const notes = typeof body?.notes === 'string' ? body.notes.trim() : '';
  if (notes.length > MAX_NOTES) return { error: `notes can be at most ${MAX_NOTES} characters` };
  const signedOff = body?.signedOff === true;
  if (!signedOff && notes === '') return { error: 'Write a note or sign off' };
  return { notes, signedOff };
}

/**
 * The reviews, newest first; the role as it is now; and the latest sign-off
 * with what changed since. `latestSignOff` is null while nobody has signed the
 * role off. Pure.
 */
export function reviewSummary(reviews, current) {
  const latest = reviews.find(r => r.signedOff) || null;
  return {
    reviews,
    current,
    latestSignOff: latest ? { ...latest, changesSince: compareSnapshots(latest.snapshot, current) } : null,
  };
}

export async function loadCompositionReviews(roleId, { pool = db, snapshot = takeSnapshot } = {}) {
  const [reviews, current] = await Promise.all([pool.query(REVIEWS_SQL, [roleId]), snapshot(roleId)]);
  return reviewSummary(reviews.rows, current);
}

/** Saves one review with a snapshot of the role right now. */
export async function saveCompositionReview(roleId, { notes, signedOff }, { by, byName }, { pool = db, snapshot = takeSnapshot } = {}) {
  const picture = await snapshot(roleId);
  const { rows } = await pool.query(INSERT_REVIEW_SQL, [roleId, notes, signedOff, by, byName ?? null, JSON.stringify(picture)]);
  return rows[0];
}
