// Lookup source: the fields an access review can show as columns or pivot axes.
//
// Two kinds of option. The built-in fields every context and resource has —
// offered whatever is picked. And the attributes the picked contexts, and the
// resources they hold, actually carry in `extendedAttributes`, discovered from
// the data: that is what replaced the customer-specific columns the review used
// to name in code. Which attributes exist is a fact about the deployment, so the
// list follows the contexts chosen (`x-lookupDependsOn: ['contexts']`).
//
// The hint says how widely an attribute is filled in ("on 38,201 of 39,072
// resources"), because an attribute set on three rows out of forty thousand is
// rarely the column anyone meant.

import * as db from '../../db/connection.js';
import { coreFields, isOfferableAttributeKey, resolveField } from '../../reports/accessReviewFields.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Most frequent first, capped — the same bound column discovery applies
// (db/columnCache.js MAX_EXTENDED_ATTR_KEYS), for the same reason: the source
// system decides how many keys there are.
const MAX_ATTRIBUTES = 300;

// A search box asks once per keystroke and the answer only changes when a
// crawler runs, so one discovery per set of contexts serves a whole typing
// session. Small and short-lived: it is a convenience, not a cache to reason
// about.
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 50;
const cache = new Map();

export function clearFieldCache() { cache.clear(); }

const scopeOf = key => (key.startsWith('context.') ? 'Context' : 'Entitlement');

const coreOption = ({ key, label }) => ({ value: key, label, hint: `${scopeOf(key)} field` });

/**
 * Scalar extendedAttributes keys of the picked contexts and of the resources
 * they hold, with how many rows carry each one. Only scalars: a nested object
 * makes a poor column and no pivot axis at all.
 */
async function discover(contextIds) {
  const cacheKey = [...contextIds].sort().join(',');
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const scalar = `jsonb_typeof(e.value) IN ('string', 'number', 'boolean')`;
  const [ctx, ent] = await Promise.all([
    db.query(
      `SELECT e.key, count(*)::int AS n, (SELECT count(*)::int FROM "Contexts" WHERE id = ANY($1::uuid[])) AS total
         FROM "Contexts" c,
              LATERAL jsonb_each(CASE WHEN jsonb_typeof(c."extendedAttributes") = 'object'
                                      THEN c."extendedAttributes" END) e
        WHERE c.id = ANY($1::uuid[]) AND ${scalar}
        GROUP BY e.key ORDER BY n DESC, e.key LIMIT $2`, [contextIds, MAX_ATTRIBUTES]),
    db.query(
      `WITH m AS (
         SELECT r."extendedAttributes" AS a
           FROM "ContextMembers" cm
           JOIN "Resources" r ON r.id = cm."memberId" AND r."deletedAt" IS NULL
          WHERE cm."contextId" = ANY($1::uuid[]) AND cm."memberType" = 'Resource')
       SELECT e.key, count(*)::int AS n, (SELECT count(*)::int FROM m) AS total
         FROM m, LATERAL jsonb_each(CASE WHEN jsonb_typeof(m.a) = 'object' THEN m.a END) e
        WHERE ${scalar}
        GROUP BY e.key ORDER BY n DESC, e.key LIMIT $2`, [contextIds, MAX_ATTRIBUTES]),
  ]);

  const options = (rows, prefix, noun) => rows
    .filter(r => isOfferableAttributeKey(r.key))
    .map(r => {
      const field = resolveField(`${prefix}${r.key}`);
      return {
        value: field.key,
        label: field.label,
        hint: `${scopeOf(prefix)} attribute · on ${r.n.toLocaleString('en-US')} of ${r.total.toLocaleString('en-US')} ${noun}`,
      };
    });
  const value = [...options(ctx.rows, 'context.ext.', 'contexts'), ...options(ent.rows, 'entitlement.ext.', 'resources')];

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

/** Whether an option matches what was typed — on its heading or on its key. */
export function matches(option, q) {
  const term = String(q ?? '').trim().toLowerCase();
  return !term || option.label.toLowerCase().includes(term) || option.value.toLowerCase().includes(term);
}

export default {
  name: 'access-review-fields',
  displayName: 'Access review fields',

  // Built-in fields first, then what the data holds. Without a context there
  // is nothing to discover, and the built-ins are still a complete answer.
  async search({ q = '', limit = 20, params = {} }) {
    const contextIds = (params.contexts || []).filter(id => UUID.test(String(id)));
    const discovered = contextIds.length ? await discover(contextIds) : [];
    return [...coreFields().map(coreOption), ...discovered]
      .filter(option => matches(option, q))
      .slice(0, limit);
  },

  // A field key is its own description, so stored keys resolve without a
  // query — including an attribute no picked context carries any more, which
  // still has to read as a name rather than as a raw key.
  async resolve({ ids = [] }) {
    return ids.map(resolveField).filter(Boolean).map(field => (field.attribute
      ? { value: field.key, label: field.label, hint: `${scopeOf(field.key)} attribute` }
      : coreOption(field)));
  },
};
