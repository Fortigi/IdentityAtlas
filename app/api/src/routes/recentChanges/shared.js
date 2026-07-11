// Shared config, query-param clamps and label-resolution helpers for the
// recent-changes / timeline endpoints.
//
// Extracted from routes/recentChanges.js (audit finding C1) so the split
// sub-routers (changes.js + timeline.js) share one definition — the label
// helpers (toEvent + the lookup* / resourceCounterpartyKind resolvers) are used
// by both. No behaviour change — pure code move.

import * as db from '../../db/connection.js';

export const useSql = process.env.USE_SQL === 'true';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function clampDays(v) {
  const n = parseInt(v, 10);
  if (!n || n < 1) return 30;
  return Math.min(365, n);
}
export function clampLimit(v) {
  const n = parseInt(v, 10);
  if (!n || n < 1) return 50;
  return Math.min(500, n);
}
// The Timeline tab wants a wider window than the recent-changes panel, so it
// has its own clamp (default 90 days, up to ~3 years). Kept separate from
// clampDays so the 365-day cap other endpoints rely on is untouched.
export function clampTimelineDays(v) {
  const n = parseInt(v, 10);
  if (!n || n < 1) return 90;
  return Math.min(1095, n);
}

export function toEvent(row, summary, counterparty) {
  const op = row.operation === 'I' ? 'added' : row.operation === 'D' ? 'removed' : 'changed';
  return {
    at: row.changedAt,
    operation: op,
    eventKind: counterparty?.eventKind || 'other',
    summary,
    counterpartyKind: counterparty?.kind || null,
    counterpartyId: counterparty?.id || null,
    counterpartyLabel: counterparty?.label || null,
  };
}

// Tiny display-name helpers. Look up by current state first; fall back
// to whatever name was stored in the history snapshot so rows stay
// readable even when the counterparty has since been deleted.
export async function lookupPrincipal(id) {
  if (!id) return null;
  try {
    const r = await db.queryOne(`SELECT "displayName" FROM "Principals" WHERE id = $1`, [id]);
    return r?.displayName || null;
  } catch { return null; }
}
export async function lookupResource(id) {
  if (!id) return null;
  try {
    const r = await db.queryOne(`SELECT "displayName", "resourceType" FROM "Resources" WHERE id = $1`, [id]);
    return r || null;
  } catch { return null; }
}
export async function lookupIdentity(id) {
  if (!id) return null;
  try {
    const r = await db.queryOne(`SELECT "displayName" FROM "Identities" WHERE id = $1`, [id]);
    return r?.displayName || null;
  } catch { return null; }
}

// Kind mapping for counterparty — so the UI can route a click to the
// right detail tab. A BusinessRole resource is shown as access-package;
// everything else as resource.
export function resourceCounterpartyKind(resType) {
  return resType === 'BusinessRole' ? 'access-package' : 'resource';
}
