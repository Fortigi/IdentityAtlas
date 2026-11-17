// @ts-check
//
// The ingest apparatus every seeding e2e shares: register a throwaway ingest
// connector, register a system of its own, push batches into it as that
// connector, ask for a matview refresh, and give the rows back on the way out.
//
// It started inside accountLinkingSeed.js, which still re-exports it so the
// account-linking specs are unchanged. It lives here because seeding through
// the real ingest is not an account-linking concern — any spec that needs a
// state the demo dataset deliberately does not contain (a removed account, a
// business role deleted in the source) seeds it exactly this way.
//
// Not a `*.spec.js`, so Playwright's testMatch never collects it as a suite.

export const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
export const API = `${BASE}/api`;

const jsonBody = (res) => res.json().catch(() => ({}));

/**
 * Register a throwaway ingest connector and a system of its own, and return the handle
 * the spec seeds through.
 *
 * Returns `{ ok: false, reason }` rather than throwing when the deployment will not allow
 * it — mock mode (`USE_SQL=false`) has no Crawlers table and no ingest to drive — which is
 * the one condition the specs skip on.
 *
 * @param {{ displayName: string, description: string, system: object, permissions?: string[] }} opts
 *   `system` is an ingest Systems record: `{ systemType, tenantId, displayName }`.
 *   `permissions` are the connector's own (default `['ingest']`); a spec that has to
 *   read a matview it just wrote also needs `'refreshViews'`.
 * @returns {Promise<{
 *   ok: boolean, reason?: string, crawlerId?: number|string, systemId?: number,
 *   ingest?: Function, mustIngest?: Function, refreshViews?: Function,
 * }>}
 */
export async function openIngestSession({ displayName, description, system, permissions = ['ingest'] }) {
  const created = await fetch(`${API}/admin/crawlers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName, description, permissions }),
  });
  if (created.status !== 201) {
    return { ok: false, reason: `could not register an ingest connector (HTTP ${created.status})` };
  }
  const crawler = await created.json();
  const session = { ok: true, crawlerId: crawler.id, systemId: undefined };

  /**
   * One ingest batch as this connector, scoped to this system. Defaults mirror what every
   * caller wants: a delta batch of no records, so a call only states what it changes.
   * @returns {Promise<{ ok: boolean, status: number, body: any }>}
   */
  session.ingest = async (entity, body = {}) => {
    const res = await fetch(`${API}/ingest/${entity}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${crawler.apiKey}` },
      body: JSON.stringify({ systemId: session.systemId, syncMode: 'delta', records: [], ...body }),
    });
    return { ok: res.ok, status: res.status, body: await jsonBody(res) };
  };

  /** The same, for a batch whose refusal means the fixture is not set up. */
  session.mustIngest = async (entity, body) => {
    const res = await session.ingest(entity, body);
    if (!res.ok) throw new Error(`ingest ${entity} failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    return res.body;
  };

  /**
   * Rebuild the matrix matviews and WAIT for it — `?wait=1`, the same call the
   * demo loader and the load benchmark make. A spec that seeds and then reads the
   * grid has to, because the matrix is served from matviews: without it the
   * assertions race a debounced background refresh.
   *
   * Throws when the connector was not given `refreshViews`, rather than leaving
   * the spec to assert against stale views.
   */
  session.refreshViews = async () => {
    const res = await fetch(`${API}/ingest/refresh-views?wait=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${crawler.apiKey}` },
      body: '{}',
    });
    if (!res.ok) throw new Error(`refresh-views failed: HTTP ${res.status}`);
    return jsonBody(res);
  };

  const registered = await session.ingest('systems', { records: [system] });
  session.systemId = registered.body?.systemIds?.[0];
  if (!session.systemId) {
    return { ...session, ok: false, reason: `could not register the fixture system (HTTP ${registered.status})` };
  }
  return session;
}

/**
 * Give the deployment its rows back.
 *
 * `Principals` and `Resources` are soft-delete tables, so seeded rows are tombstoned
 * rather than removed and the purge finalises them after the history-retention window —
 * that is the ingest contract, not something to work around here. The system row can only
 * be disabled (the API has no delete for Systems), so one disabled connector per replay is
 * residue no spec can clear.
 *
 * @param {object} session the handle from `openIngestSession`
 * @param {{ identityIds?: string[], principalIds?: string[], resourceIds?: string[], systemNote?: string }} what
 */
export async function closeIngestSession(
  session, { identityIds = [], principalIds = [], resourceIds = [], systemNote } = {},
) {
  if (session?.systemId) {
    // Identities first: a hard delete cascades the IdentityMembers rows this run wrote,
    // so a replay starts with every seeded account orphaned again.
    if (identityIds.length) await session.ingest('identities', { deletedIds: identityIds }).catch(() => {});
    if (principalIds.length) await session.ingest('principals', { deletedIds: principalIds }).catch(() => {});
    if (resourceIds.length) await session.ingest('resources', { deletedIds: resourceIds }).catch(() => {});
    if (systemNote) {
      await fetch(`${API}/systems/${session.systemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false, description: systemNote }),
      }).catch(() => {});
    }
  }
  if (session?.crawlerId != null) {
    await fetch(`${API}/admin/crawlers/${session.crawlerId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permanent: true }),
    }).catch(() => {});
  }
}
