// JSON POST helper shared by the report builder's assistant and its hooks.
// Re-exported from AskAssistant.jsx, which is where the rest of the builder
// imports it from; it lives here so the assistant's own hooks can use it
// without importing the component that imports them.

export async function postJson(authFetch, url, body, method = 'POST') {
  const res = await authFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json.errors?.length ? `: ${json.errors.join('; ')}` : '';
    const err = new Error(`${json.error || `Request failed (${res.status})`}${detail}`);
    err.body = json; // callers can react to structured answers, e.g. a confirmation
    throw err;
  }
  return json;
}
