// A "last used" stamp that can never take the connection pool down with it.
//
// Crawler keys and read tokens used to run one fire-and-forget
// `UPDATE … SET "lastUsedAt" = now() WHERE id = $1` per authenticated request.
// Every one of them writes the SAME row, so they queue on its row lock, and a
// fire-and-forget query still holds a pool connection while it waits. A client
// sending requests quickly (the staged full load appends 10k-row batches back to
// back) meant that one slow commit — a WAL flush stalled for ~5 s behind an
// autovacuum on the scale rig — was enough for the queue to hold all 10 pool
// connections. Every other request, including crawler auth itself and the
// worker's job poll, then failed with "timeout exceeded when trying to connect"
// (docs/architecture/scale-rehearsal.md, step 7).
//
// Two changes, either of which alone stops the pile-up:
//   * at most one stamp per id per interval (the stamp is read at day or hour
//     granularity: "last used", idle auto-revoke);
//   * the UPDATE locks its row with SKIP LOCKED, so a stamp that finds another
//     one in progress does nothing instead of waiting behind it.

// Wrap a single-row stamp in `WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`.
export function skipLockedStampSql(table, column, value) {
  return `UPDATE "${table}" SET "${column}" = ${value}
           WHERE id = (SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE SKIP LOCKED)`;
}

// Returns touch(id): runs the stamp for `id` unless one ran within `intervalMs`.
// Never awaited by callers; a failed stamp is forgotten so the next request
// retries it. `now` is injectable for tests.
export function createThrottledTouch(run, sql, { intervalMs = 60_000, now = Date.now } = {}) {
  const last = new Map();
  return function touch(id) {
    const t = now();
    const prev = last.get(id);
    if (prev !== undefined && t - prev < intervalMs) return false;
    last.set(id, t);
    Promise.resolve()
      .then(() => run(sql, [id]))
      .catch(() => { if (last.get(id) === t) last.delete(id); });
    return true;
  };
}
