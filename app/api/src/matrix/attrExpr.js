// Resolve a matrix grouping/roll-up attribute to a safe SQL expression.
//
// An attribute is either a REAL column of the subject table (department,
// jobTitle, …) or an extendedAttributes JSON key surfaced as `ext.<key>`. Real
// columns are validated against the discovered column list; both forms are
// guarded by SAFE_IDENT_RE so a caller-supplied name can never break out of the
// identifier/quote context.
//
// Used by /matrix/scope-breakdown and the /matrix/data roll-up aggregation.

const SAFE_IDENT_RE = /^[a-zA-Z0-9_]+$/;
const EXT_PREFIX = 'ext.';

/**
 * @param {string} rawAttr  e.g. 'department' or 'ext.costCenter'
 * @param {string} alias    table alias to qualify the column with (e.g. 'u' or 'i')
 * @param {{name:string}[]} cols  discovered real columns of the subject table
 * @returns {{ attrExpr: string } | { error: string }}
 */
export function resolveAttrExpr(rawAttr, alias, cols) {
  if (typeof rawAttr !== 'string' || !rawAttr) return { error: 'attribute is required' };

  if (rawAttr.startsWith(EXT_PREFIX)) {
    const key = rawAttr.slice(EXT_PREFIX.length);
    if (!SAFE_IDENT_RE.test(key)) return { error: 'invalid attribute' };
    return { attrExpr: `${alias}."extendedAttributes"->>'${key}'` };
  }

  if (!SAFE_IDENT_RE.test(rawAttr)) return { error: 'invalid attribute' };
  if (!Array.isArray(cols) || !cols.some(c => c.name === rawAttr)) return { error: 'unknown attribute' };
  return { attrExpr: `${alias}."${rawAttr}"` };
}
