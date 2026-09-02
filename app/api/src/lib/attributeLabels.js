// Display names for `extendedAttributes` keys — the ONE place the rule lives.
//
// Entra directory-extension attributes arrive from Graph under their wire name,
// `extension_<32-hex appId>_<attributeName>` (the middle segment is the appId of
// the application the extension was defined for, not the tenant id). That prefix
// is meaningless to an analyst and, at ~50 characters, crowds every label out of
// its column. This module turns it into the readable tail — `sAMAccountName`,
// `sfCostCenterID`, `fgGroupDN_OuPath` — while the stored key stays byte-identical
// so filters, sorts and matrix attributes keep addressing the real JSON key.
//
// Two inputs, in priority order:
//
//   1. The crawler's stamped map. `Systems.extendedAttributes.attributeDisplayNames`
//      holds rawKey -> friendly name for the system that produced the data. The
//      crawler sees a system's whole attribute set, so it is the only layer that
//      can disambiguate two apps defining the same attribute name.
//   2. The rule below, applied at read time to anything the map doesn't cover.
//      This is what makes labels clean on day one for an install that has not
//      re-crawled, and for keys from Omada / CSV / custom connectors that the
//      Entra crawler never touches.
//
// Everything user-facing — the detail tables, the filter menus, the matrix picker
// and headers, the matrix xlsx export and the Power Query workbook — resolves
// through this module (the browser via the label channel on the column endpoints
// and GET /api/attribute-labels; the workbook via the same endpoint from M). Two
// implementations of one regex is exactly how Excel and the browser would drift
// apart, so there is only one.

import * as db from '../db/connection.js';

// The directory-extension key shape. `ext_` is our own Excel-export namespace and
// is accepted here too, so a key that already carries it resolves the same way.
// Deliberately anchored and exactly 32 hex chars: `extension_nothex_foo` is NOT
// an extension key and must be left alone.
export const EXTENSION_KEY_RE = /^ext(?:ension)?_([0-9a-f]{32})_(.+)$/i;

// The 32-hex appId segment of a directory-extension key, or null.
export function extensionAppId(key) {
  const m = EXTENSION_KEY_RE.exec(String(key ?? ''));
  return m ? m[1].toLowerCase() : null;
}

// The rule: everything after the `extension_<appId>_` prefix, VERBATIM. No word
// splitting — the requested label is `sAMAccountName`, not `S A M Account Name`.
// A key that doesn't match the shape is returned unchanged.
export function stripExtensionPrefix(key) {
  const raw = String(key ?? '');
  const m = EXTENSION_KEY_RE.exec(raw);
  return m ? m[2] : raw;
}

// The crawler-stamped override for one key, or '' when there isn't a usable one.
// A non-string or whitespace-only entry is treated as absent so a half-written
// map can't pin an empty label over the rule's answer.
function overrideFor(overrides, key) {
  const value = overrides ? overrides[key] : undefined;
  return typeof value === 'string' ? value.trim() : '';
}

// key -> { label, pinned } for every usable key. `pinned` marks a label that came
// from the stamped map, which wins outright and is never suffixed below.
function proposeLabels(keys, overrides) {
  const proposed = new Map();
  for (const key of keys || []) {
    if (typeof key !== 'string' || key === '') continue;
    const override = overrideFor(overrides, key);
    proposed.set(key, { label: override || stripExtensionPrefix(key), pinned: !!override });
  }
  return proposed;
}

// The set of labels that more than one key proposed — the ones needing an appId
// suffix to stay distinguishable.
function collidingLabels(proposed) {
  const seen = new Set();
  const collisions = new Set();
  for (const { label } of proposed.values()) {
    if (seen.has(label)) collisions.add(label);
    seen.add(label);
  }
  return collisions;
}

// Build rawKey -> label over a whole key set.
//
// `overrides` is the crawler-stamped map; an entry there wins outright. For
// everything else the rule applies, and any label two or more keys would end up
// sharing is disambiguated with the first 8 characters of the owning appId
// (`employeeID (8ce8d3db)`), so two extension apps defining the same attribute
// stay distinguishable. Storage keys are never touched.
//
// Only keys whose label actually differs from the key are returned — a caller can
// then treat "no entry" as "nothing to relabel" and keep its existing rendering.
export function buildAttributeLabels(keys, overrides = {}) {
  const proposed = proposeLabels(keys, overrides);
  const collisions = collidingLabels(proposed);

  // Null-prototype: callers do `labels[key]` over keys that come from the data,
  // and `constructor` / `toString` are perfectly legal JSON keys — an inherited
  // Object.prototype member must not read back as somebody's display name.
  const labels = Object.create(null);
  for (const [key, { label, pinned }] of proposed) {
    const appId = !pinned && collisions.has(label) ? extensionAppId(key) : null;
    const resolved = appId ? `${label} (${appId.slice(0, 8)})` : label;
    if (resolved !== key) labels[key] = resolved;
  }
  return labels;
}

// ─── Stamped-map + key-set lookup (cached) ──────────────────────────
//
// Both halves are read once per TTL: the crawler-stamped maps are a handful of
// rows on Systems, and the per-table key list is a jsonb_object_keys scan we do
// not want on every filter-dropdown request. Mirrors db/columnCache.js's 5-minute
// TTL so a fresh crawl shows up on the same timescale as new columns do.

const LABEL_CACHE_TTL = 5 * 60 * 1000;

// target -> the table whose extendedAttributes keys it labels.
export const LABEL_TARGET_TABLES = {
  principal: 'Principals',
  resource: 'Resources',
  identity: 'Identities',
  system: 'Systems',
};

let cache = new Map();       // target -> { labels, at }
let overridesCache = null;   // merged attributeDisplayNames across all systems
let overridesCacheTime = 0;

export function clearAttributeLabelCache() {
  cache = new Map();
  overridesCache = null;
  overridesCacheTime = 0;
}

// Merge every system's stamped `attributeDisplayNames` map. Systems are the only
// writer, and a raw key is unique to the system that produced it, so a plain
// merge is safe. A system that has never been crawled by a stamping crawler
// simply contributes nothing and falls through to the rule.
async function loadOverrides() {
  const now = Date.now();
  if (overridesCache && (now - overridesCacheTime) < LABEL_CACHE_TTL) return overridesCache;
  const merged = Object.create(null);
  const r = await db.query(
    `SELECT "extendedAttributes"->'attributeDisplayNames' AS m
       FROM "Systems"
      WHERE "extendedAttributes" ? 'attributeDisplayNames'`
  );
  for (const row of r.rows) {
    const m = typeof row.m === 'string' ? JSON.parse(row.m) : row.m;
    if (m && typeof m === 'object') Object.assign(merged, m);
  }
  overridesCache = merged;
  overridesCacheTime = Date.now();
  return merged;
}

async function loadKeys(table) {
  const r = await db.query(
    `SELECT DISTINCT jsonb_object_keys("extendedAttributes") AS k
       FROM "${table}"
      WHERE "extendedAttributes" IS NOT NULL`
  );
  return r.rows.map(row => row.k);
}

// rawKey -> label for one target, or for the union of every target when `target`
// is omitted. Only relabelled keys are present.
export async function getAttributeLabels(target) {
  const key = target || '*';
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && (now - hit.at) < LABEL_CACHE_TTL) return hit.labels;

  const tables = target ? [LABEL_TARGET_TABLES[target]] : Object.values(LABEL_TARGET_TABLES);
  const overrides = await loadOverrides();
  const keys = new Set();
  for (const table of tables) {
    for (const k of await loadKeys(table)) keys.add(k);
  }
  const labels = buildAttributeLabels(keys, overrides);
  cache.set(key, { labels, at: Date.now() });
  return labels;
}

// Attach `label` to the `ext.<rawKey>` entries of a column-discovery response.
//
// Reuses the `label` channel the filter-menu builder already honours for
// reference fields, so no consumer needs a second code path: an entry with a
// label renders it, an entry without keeps whatever it rendered before (which is
// why `ext.userType` still reads "User Type (ext)").
//
// Failure is non-fatal — a column list without labels is the pre-change UI, not a
// broken page.
export async function withAttributeLabels(columns, target) {
  if (!Array.isArray(columns) || columns.length === 0) return columns;
  let labels;
  try {
    labels = await getAttributeLabels(target);
  } catch (err) {
    console.error('attribute-label lookup failed:', err.message);
    return columns;
  }
  return columns.map(col => {
    if (!col || col.label || typeof col.column !== 'string' || !col.column.startsWith('ext.')) return col;
    const label = labels[col.column.slice(4)];
    return label ? { ...col, label } : col;
  });
}
