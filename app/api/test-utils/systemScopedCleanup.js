// Shared teardown for contract tests that seed a whole system.
//
// Contract files run against ONE shared database, so each has to remove its own
// rows or it pollutes its siblings. The delete order is the FK order — the
// tables that reference a resource/principal go before the rows they point at,
// and "Systems" last. Every file that seeds Systems → Principals/Resources →
// assignments/relationships needs exactly this block, which is why it lives here
// rather than being pasted per file (the jscpd duplication gate counts clones
// across contract tests too).
//
// Files with extra tables of their own (Contexts, RiskClassifiers,
// PrincipalRelationships, …) delete those first and then call this.

const FK_ORDERED_TABLES = [
  ['ResourceAssignments', 'systemId'],
  ['ResourceRelationships', 'systemId'],
  ['Resources', 'systemId'],
  ['Principals', 'systemId'],
  ['Systems', 'id'],
];

/**
 * Delete every row this system owns, innermost FK first.
 *
 * @param {import('pg').Pool} pool  Pool to run the deletes on. A nullish pool is
 *   a no-op, so an afterAll still runs cleanly when beforeAll failed to connect.
 * @param {number|string} systemId  The seeded system's id. Nullish is a no-op.
 */
export async function deleteSystemScopedRows(pool, systemId) {
  if (!pool || systemId == null) return;
  for (const [table, column] of FK_ORDERED_TABLES) {
    await pool.query(`DELETE FROM "${table}" WHERE "${column}" = $1`, [systemId]);
  }
}
