import { randomUUID } from 'crypto';

/**
 * Shared helpers for creating and bulk-loading PostgreSQL temp tables.
 * Used by engine.js (chunkSize 1000, UUID defaults) and sessions.js (chunkSize 200).
 */

export async function createTempTable(client, tempName, activeColumns) {
  const colDefs = activeColumns
    .map(c => `"${c.name}" ${c.sqlTypeName === 'USER-DEFINED' ? 'text' : c.sqlTypeName}`)
    .join(', ');
  await client.query(`CREATE TEMP TABLE "${tempName}" (${colDefs}) ON COMMIT DROP`);
}

/**
 * Bulk-insert records into an existing temp table using batched INSERT … VALUES.
 *
 * @param {object}   client          - pg client (inside a transaction)
 * @param {string}   tempName        - temp table name
 * @param {Array}    activeColumns   - column descriptors ({ name, hasUuidDefault? })
 * @param {Array}    records         - plain objects to insert
 * @param {number}   chunkSize       - rows per INSERT statement (200 for sessions, 1000 for engine)
 * @param {boolean}  applyUuidDefaults - when true, null values for UUID-default columns get crypto.randomUUID()
 */
export async function bulkInsertIntoTemp(client, tempName, activeColumns, records, chunkSize, applyUuidDefaults = false) {
  const colList = activeColumns.map(c => `"${c.name}"`).join(', ');
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    const placeholders = [];
    const params = [];
    let pi = 1;
    for (const rec of chunk) {
      const row = [];
      for (const col of activeColumns) {
        row.push(`$${pi++}`);
        let val = rec[col.name] !== undefined ? rec[col.name] : null;
        if (applyUuidDefaults && val === null && col.hasUuidDefault) val = randomUUID();
        params.push(val);
      }
      placeholders.push(`(${row.join(',')})`);
    }
    await client.query(
      `INSERT INTO "${tempName}" (${colList}) VALUES ${placeholders.join(',')}`,
      params
    );
  }
}
