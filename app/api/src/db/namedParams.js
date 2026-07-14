// Named-parameter binding for dynamically-composed SQL.
//
// node-postgres only accepts positional ($1, $2, …) placeholders, which are
// awkward when a WHERE clause is assembled from a variable number of optional
// filters. This helper lets a handler compose SQL with readable @name
// placeholders plus a { name: value } bindings map, then rewrites it to the
// positional form pg expects.
//
//   const { text, values } = bindNamedParams(
//     'SELECT * FROM t WHERE a = @x AND b ILIKE @x',
//     { x: 5 },
//   );
//   // text  = 'SELECT * FROM t WHERE a = $1 AND b ILIKE $1'
//   // values = [5]
//
// Rules:
//   • Repeated @names collapse to a single $N (so the value is bound once).
//   • @names inside single-quoted string literals are left untouched.
//   • Only @names that actually appear in the SQL are included in `values`,
//     so a caller may pass a superset of bindings (e.g. the same map to both a
//     data query and its narrower COUNT query) without pg complaining about
//     unused parameters.

export function bindNamedParams(sqlText, bindings = {}) {
  const order = [];
  let out = '';
  let i = 0;
  let inString = false;
  while (i < sqlText.length) {
    const ch = sqlText[i];
    if (ch === "'" && sqlText[i - 1] !== '\\') {
      inString = !inString;
      out += ch;
      i++;
      continue;
    }
    if (!inString && ch === '@' && /[A-Za-z_]/.test(sqlText[i + 1] || '')) {
      let j = i + 1;
      while (j < sqlText.length && /[A-Za-z0-9_]/.test(sqlText[j])) j++;
      const name = sqlText.slice(i + 1, j);
      let idx = order.indexOf(name);
      if (idx === -1) { order.push(name); idx = order.length - 1; }
      out += '$' + (idx + 1);
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, values: order.map((n) => bindings[n]) };
}
