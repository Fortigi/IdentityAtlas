// How tool results are shaped for an AI assistant.
//
// Every tool answers with the same two parts:
//   - structuredContent: the data as an object (columns, rows, totals) — what a
//     client uses to draw a chart or a table;
//   - one text block holding the same object as JSON, for clients that only read
//     text.
// Rows are capped (the assistant's context is finite and an answer of 40 000
// rows is not an answer); `truncated` says when the cap cut something off, so
// the assistant never presents the first N rows as the whole picture. Each row
// carries a `link` back to its detail page in Identity Atlas when it has one.

export const DEFAULT_ROWS = 100;
export const MAX_ROWS = 500;

export function rowLimit(requested) {
  const n = Number(requested);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_ROWS;
  return Math.min(n, MAX_ROWS);
}

export function detailLink(baseUrl, entity) {
  if (!entity?.kind || entity.id == null) return undefined;
  return `${baseUrl}/#${entity.kind}:${encodeURIComponent(entity.id)}`;
}

// Strip the UI-only row properties (_entity, _links) and add the link.
export function cleanRow(row, baseUrl) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (!k.startsWith('_')) out[k] = v;
  }
  const link = detailLink(baseUrl, row._entity);
  if (link) out.link = link;
  return out;
}

export function tableResult({ rows, limit, baseUrl, truncated = false, ...rest }) {
  const shown = rows.slice(0, limit).map(r => cleanRow(r, baseUrl));
  return jsonResult({
    ...rest,
    rowCount: shown.length,
    truncated: truncated || rows.length > limit,
    rows: shown,
  }, shown.length);
}

// `rowCount` is not part of the protocol: it is read by the audit log.
export function jsonResult(payload, rowCount = null) {
  return {
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    rowCount,
  };
}

export function errorResult(message, details) {
  const payload = details === undefined ? { error: message } : { error: message, ...details };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    rowCount: null,
  };
}
