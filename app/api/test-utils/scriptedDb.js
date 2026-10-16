// A scripted stand-in for the db/connection.js `query` spy, for route tests that issue
// several queries per request.
//
// Each rule is [regex, rows | (sql, params) => rows]. The FIRST rule whose regex matches
// the SQL answers; a query no rule matches THROWS, so an unexpected statement — a write
// to a table the route should never touch — fails the test instead of quietly getting
// an empty result. Every call is recorded in `calls` for assertions on what was sent.
//
//   const db = scriptedDb(query, [
//     [/FROM "Interviews"/, [{ id: 'i1', ownerKey: 'oid:u1' }]],
//     [/INSERT INTO "InterviewEvents"/, []],
//   ]);
//   ... request ...
//   expect(db.calls.map(c => c.sql)).not.toContainEqual(expect.stringMatching(/"Resources"/));
//
// Still SQL-blind in the sense app/api/CLAUDE.md warns about: it matches text, it does
// not run it. Whether the SQL is valid is the contract tests' job.

export function scriptedDb(querySpy, rules) {
  const calls = [];
  querySpy.mockImplementation(async (sql, params = []) => {
    calls.push({ sql: String(sql), params });
    const rule = rules.find(([re]) => re.test(String(sql)));
    if (!rule) throw new Error(`scriptedDb: no rule for SQL: ${String(sql).replace(/\s+/g, ' ').slice(0, 160)}`);
    const answer = typeof rule[1] === 'function' ? rule[1](String(sql), params) : rule[1];
    return { rows: answer ?? [], rowCount: (answer ?? []).length };
  });
  return {
    calls,
    /** Every statement that wrote (INSERT/UPDATE/DELETE), as `VERB "Table"`. */
    writes: () => calls
      .map(c => c.sql.match(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+"(\w+)"/))
      .filter(Boolean)
      .map(m => `${m[1]} "${m[2]}"`),
  };
}
