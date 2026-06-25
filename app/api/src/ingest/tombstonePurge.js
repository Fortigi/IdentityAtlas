// Finalize soft-deleted (tombstoned) rows once they age past the retention window.
//
// Soft-delete keeps a vanished entity around (stamped deletedAt) so it stays
// auditable and cross-system references don't dangle. After the configured
// retention it's finally hard-deleted — the _history trigger records the final
// 'D' row, so the audit trail survives in _history (which is pruned to the same
// window). One global value (WorkerConfig HISTORY_RETENTION_DAYS) governs both.
//
// Assignments are purged before principals/resources so a hard-deleted holder or
// target doesn't briefly leave a dangling assignment. db is injected for testing.

// Ordered: assignments first, then the entities they referenced.
export const PURGE_ORDER = ['ResourceAssignments', 'Principals', 'Resources'];

export async function purgeExpiredTombstones(db, days) {
  const purged = {};
  if (!Number.isInteger(days) || days <= 0) return { purged }; // 0/invalid disables purge
  for (const table of PURGE_ORDER) {
    const res = await db.query(
      `DELETE FROM "${table}"
        WHERE "deletedAt" IS NOT NULL
          AND "deletedAt" < now() - ($1::int * interval '1 day')`,
      [days]
    );
    if (res.rowCount) purged[table] = res.rowCount;
  }
  return { purged };
}
