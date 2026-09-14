// The one way the matrix's save and share surfaces send JSON to the API (#1202).
//
// The share form and the wizard's Save & share step both create saved matrices
// and shares; they must read a refusal the same way — the API's own message when
// it sent one, the status when it did not — and a name clash (409) must stay
// recognisable so the caller can show it on the name field rather than as a
// general error.

// Send `body` as JSON and return the parsed response. Throws an Error carrying
// `status` on a non-2xx answer; `fallback` is the message used when the API's
// refusal has none of its own.
export async function sendJson(authFetch, url, { method = 'POST', body, fallback = 'Request failed' } = {}) {
  const res = await authFetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(parsed?.error || `${fallback} (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  return parsed;
}

// A refusal because the name is already taken.
export function isNameClash(err) {
  return err?.status === 409;
}
