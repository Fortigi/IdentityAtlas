// Shared fixture for the #928 matrix column-value contract tests.
//
// columnValuesTruncation, columnValueSearch and columnValuesSmallTenant each
// pin a different property of the value-discovery contract (alphabetical page /
// searchable beyond the page / the same behaviour on a small tenant), but they
// all need the same scaffolding: boot the app against the contract database,
// own a Systems row, fill it with Resources that differ only in `description`,
// and drop it all again afterwards. That setup lives here so the three files
// state only what they actually assert.
//
// Callers that `vi.resetModules()` (all three do — the value caches are
// module-level with a 5-minute TTL and contract tests share one process) must
// import this module dynamically, after the reset, so the app it boots is the
// fresh one.

import { bootContractApp } from './contractApp.js';

/**
 * Boots the contract app and seeds one Systems row with a Resources row per
 * description.
 *
 * @param {object} opts
 * @param {string} opts.systemName    displayName for the owning Systems row.
 * @param {string} opts.namePrefix    prefix for the generated resource names.
 * @param {string[]} opts.descriptions one Resources row per entry.
 * @param {boolean} [opts.withCostCenter] also stamp an `ext.costCenter`
 *   attribute (`CC-<n>`) on every row, for the JSON-path search assertions.
 * @returns {Promise<{agent: object, pool: object, systemId: number}>}
 */
export async function seedDescribedResources({
  systemName,
  namePrefix,
  descriptions,
  withCostCenter = false,
}) {
  const { agent, pool } = await bootContractApp();
  const systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName")
     VALUES ('test', $1) RETURNING "id"`,
    [systemName],
  )).rows[0].id;
  const extColumn = withCostCenter ? ', "extendedAttributes"' : '';
  const extValue = withCostCenter
    ? `, jsonb_build_object('costCenter', 'CC-' || d.ord)`
    : '';
  await pool.query(
    `INSERT INTO "Resources" ("systemId", "displayName", "resourceType", "enabled", "description"${extColumn})
     SELECT $1, $2::text || d.ord, 'Group', true, d.val${extValue}
       FROM unnest($3::text[]) WITH ORDINALITY AS d(val, ord)`,
    [systemId, namePrefix, descriptions],
  );
  return { agent, pool, systemId };
}

/**
 * Removes everything {@link seedDescribedResources} created and closes the
 * pool. `USE_SQL` is cleared because contract tests share one process
 * (singleFork) and env mutations leak across files.
 */
export async function dropSeededResources({ pool, systemId }) {
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL;
}

/**
 * Every distinct, non-empty description currently stored — including rows left
 * by other contract-test files, since the endpoint reports on all of them.
 */
export async function storedDescriptions(pool) {
  const r = await pool.query(
    `SELECT DISTINCT "description"::text AS val
       FROM "Resources"
      WHERE "description" IS NOT NULL AND "description"::text <> ''
      ORDER BY val`,
  );
  return r.rows.map(row => row.val);
}
