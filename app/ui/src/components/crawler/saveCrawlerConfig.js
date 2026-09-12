// Create or update one CrawlerConfigs row from a wizard.
//
// Every wizard ended with the same block: PATCH when editing an existing
// config, POST otherwise, unwrap the API's { error } on a non-2xx, and fall
// back to the status code when there isn't one. Same code, once.
//
// Throws on failure so the caller's existing try/catch surfaces the message;
// returns the saved row on success.
export default async function saveCrawlerConfig({ authFetch, crawlerType, configId, displayName, config }) {
  const body = { displayName: (displayName || '').trim(), config };
  const r = configId
    ? await authFetch(`/api/admin/crawler-configs/${configId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    : await authFetch('/api/admin/crawler-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crawlerType, ...body }),
      });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `HTTP ${r.status}`);
  }
  return r.json().catch(() => ({}));
}
