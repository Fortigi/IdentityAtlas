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
//   if (search) { const s = bind(`%${search}%`); where += ` AND (a ILIKE ${s} OR b ILIKE ${s})`; }
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
