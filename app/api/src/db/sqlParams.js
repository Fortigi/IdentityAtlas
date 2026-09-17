// Positional-parameter builder for dynamically-composed pg queries.
//
// pg only accepts positional ($1, $2, …) placeholders. When a WHERE clause is
// assembled from a variable number of optional filters — and from shared SQL
// fragment helpers (buildFilterWhere, the risk-list generator, …) — this keeps
// one params array and hands out the right $N for each value, so callers never
// hand-number and fragments can't collide.
//
//   const { params, bind } = createParams();
//   let where = '1=1';
//   if (search) { const s = bind(likeContains(search)); where += ` AND (a ILIKE ${s} ESCAPE '\\' OR b ILIKE ${s} ESCAPE '\\')`; }
//   if (type)   where += ` AND type = ${bind(type)}`;
//   await db.query(`SELECT … WHERE ${where}`, params);
//
// bind(value) appends value to `params` and returns its `$N` token. When the
// same value appears more than once in the SQL, capture the token in a variable
// (`const s = bind(v)`) and reuse it so the value is bound only once.
export function createParams() {
  const params = [];
  const bind = (value) => `$${params.push(value)}`;
  return { params, bind };
}

// LIKE/ILIKE "contains" search on user input. Postgres treats % and _ in a
// pattern as wildcards and \ as the escape character, so a raw search term is
// not a literal substring: "_" matches any character and "%" matches anything,
// turning a lookup into a broad (and slower) scan (SEC-2026-09 L-14).
// escapeLike() backslash-escapes those three characters; pair the bound value
// with an explicit ESCAPE '\' on every ILIKE that uses it —
// routes/likeAudit.test.js fails on a bound ILIKE without one.
export function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (ch) => '\\' + ch);
}

// "%<escaped value>%" — the bound value for a contains-search.
export function likeContains(value) {
  return '%' + escapeLike(value) + '%';
}

// "<escaped value>%" / "%<escaped value>" — one-sided searches (starts/ends with).
export function likeStartsWith(value) {
  return escapeLike(value) + '%';
}

export function likeEndsWith(value) {
  return '%' + escapeLike(value);
}
