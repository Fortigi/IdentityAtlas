// Shared parsing for the paginated list endpoints: a trimmed/capped search
// term, limit (1..10000, default 100), offset (>= 0), and the parsed
// attribute-filters JSON blob. Per-endpoint extras (tag filters, sort, etc.)
// stay in the caller.
export function parseListParams(req) {
  const search = (req.query.search || '').trim().slice(0, 200);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 10000);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);

  let attrFilters = {};
  if (req.query.filters) {
    try { attrFilters = JSON.parse(req.query.filters); } catch { /* ignore bad JSON */ }
  }
  return { search, limit, offset, attrFilters };
}
