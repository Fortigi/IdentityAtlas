// Organisation → Import wizard: the calls to /api/org-truth and their errors.
//
// One place for the authFetch error idiom the handover prescribes
//   if (!r.ok) { const p = await r.json().catch(() => ({})); throw new Error(p.error || `HTTP ${r.status}`) }
// plus the wizard's own rule: a 501 (the composed router's answer for a route no
// workstream has built yet) becomes a NotAvailableError whose message the panels
// show as a notice, never as a crash.
//
// Response-shape tolerance (assumptions the integrator verifies against T1/T2):
//   - GET /profiles may answer an array or { profiles: [...] }      → asList(body, 'profiles')
//   - POST /links/detect may answer an array or { candidates: [...] } → asList(body, 'candidates')
//   - POST /sources answers the source row plus `columns`; `rowCount` is read
//     from the top level when present (sourceFromUpload).

export const API = '/api/org-truth';
export const NOT_AVAILABLE = "This step's service is not available yet on this server.";

export class NotAvailableError extends Error {
  constructor() {
    super(NOT_AVAILABLE);
    this.name = 'NotAvailableError';
    this.notAvailable = true;
  }
}

export async function readOrThrow(r) {
  if (r.status === 501) throw new NotAvailableError();
  if (!r.ok) {
    const p = await r.json().catch(() => ({}));
    const detail = Array.isArray(p.errors) && p.errors.length ? ` ${p.errors.join(' ')}` : '';
    throw new Error(`${p.error || `HTTP ${r.status}`}${detail}`);
  }
  return r.json();
}

export async function getJson(authFetch, path) {
  return readOrThrow(await authFetch(`${API}${path}`));
}

export async function sendJson(authFetch, path, body, method = 'POST') {
  return readOrThrow(await authFetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

// Multipart: no Content-Type header, the browser sets the boundary.
export async function sendForm(authFetch, path, formData) {
  return readOrThrow(await authFetch(`${API}${path}`, { method: 'POST', body: formData }));
}

export function asList(body, key) {
  if (Array.isArray(body)) return body;
  return Array.isArray(body?.[key]) ? body[key] : [];
}

export function sourceFromUpload(body) {
  return {
    id: body.id,
    displayName: body.displayName ?? body.fileName ?? '',
    fileName: body.fileName ?? '',
    observedAt: body.observedAt ?? null,
    rowCount: body.rowCount ?? null,
    columns: Array.isArray(body.columns) ? body.columns : [],
  };
}

// yyyy-mm-dd of a millisecond timestamp, for the observed-date input.
export function isoDate(ms) {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}
