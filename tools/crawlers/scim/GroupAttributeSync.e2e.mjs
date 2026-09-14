// @ts-check
/**
 * Issue #1209 — "the SCIM crawler is not reading all attributes of the group
 * object" — replayed the way it was reported: against a running deployment,
 * end to end, from a SCIM endpoint through the crawler into what the analyst
 * sees on the group.
 *
 * ConfigWizard.e2e.mjs covers the operator's half of this (pick a group
 * attribute, save it, reopen it) but stubs discovery and never runs a crawl, so
 * it would have passed just as green while the crawler dropped every value —
 * the actual complaint. What makes the values disappear is RFC 7643 §3.3:
 * discovery advertises an extension attribute under its BARE name, the resource
 * JSON carries it under the extension's URN, and the core Group schema has only
 * displayName and members, so *every* pickable group attribute is one of these.
 * Reading the bare name off the top level therefore yields nothing at all.
 *
 * So this spec serves group objects with their attributes nested under an
 * extension URN — the compliant shape, and the only one that can tell a working
 * extension lookup from a broken one — selects those attributes, runs a real
 * crawl through the real dispatcher, and asserts the values reach both the API
 * and the group's detail page.
 *
 * Test-ScimCrawler.ps1 asserts the same thing at the ingest layer. This adds the
 * half that only a browser can: the analyst opening the group and seeing the
 * attribute rendered.
 *
 * Named *.e2e.mjs and exporting register(test, expect) for the reason explained
 * in ConfigWizard.e2e.mjs — app/ui/e2e/crawler-plugin-tests.spec.js is the one
 * loader that imports @playwright/test and calls register() on every such file.
 */

import { createServer } from 'http';
import { networkInterfaces } from 'os';
import {
  E2E_API as API,
  E2E_BASE as BASE,
  deleteCrawlerConfigs,
  enableFeatureFlag,
} from '../shared/wizardE2EKit.mjs';

// Config names this spec creates, so cleanup can find them again.
const CONFIG_PREFIX = 'e2e-scim-sync-';

// The extension URNs the fixtures nest their attributes under. Mirrors the
// defaults in tools/crawlers/shared/Start-MockScimServer.ps1 — the enterprise
// User extension is the one from RFC 7643 §4.3; the Group one is an example URN,
// because RFC 7643 defines no standard Group extension and that is precisely why
// real deployments all use a vendor one.
const USER_EXT = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const GROUP_EXT = 'urn:example:params:scim:schemas:extension:mock:2.0:Group';

/**
 * A minimal SCIM 2.0 service provider, enough for discovery (/ResourceTypes,
 * /Schemas, /ServiceProviderConfig) and the crawl (/Users, /Groups with
 * RFC 7644 §3.4.2 startIndex/count paging).
 *
 * Yes, tools/crawlers/shared/Start-MockScimServer.ps1 already mocks SCIM — but
 * it is a dot-sourced PowerShell function returning a background-job handle, not
 * a process a Playwright spec can start, and reaching it would mean shelling out
 * to pwsh from Node and marshalling the handle back. This serves the same
 * documents from the runtime the spec already lives in.
 */
function startMockScimProvider(tag) {
  const users = [{
    id: `u-${tag}`,
    userName: `alice.${tag}`,
    displayName: `Alice ${tag}`,
    active: true,
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User', USER_EXT],
    // Nested under the URN, NOT at the top level. A fixture that put these at
    // the top level passes with or without the extension lookup, which is how
    // #1209 shipped green.
    [USER_EXT]: { department: 'Finance', costCenter: 'CC-42' },
  }];
  const groups = [{
    id: `g-${tag}`,
    displayName: `Group ${tag}`,
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group', GROUP_EXT],
    [GROUP_EXT]: { type: 'security', description: `Managed by ${tag}` },
    members: [{ value: `u-${tag}` }],
  }];

  const schemas = [
    { id: 'urn:ietf:params:scim:schemas:core:2.0:User', name: 'User', attributes: [
      { name: 'userName', type: 'string' }, { name: 'displayName', type: 'string' }, { name: 'active', type: 'boolean' }] },
    { id: USER_EXT, name: 'EnterpriseUser', attributes: [
      { name: 'department', type: 'string' }, { name: 'costCenter', type: 'string' }] },
    // The core Group schema really does offer nothing pickable — displayName and
    // members are both core-mapped, so the picker would be empty without the
    // extension below. That emptiness is the root of #1209.
    { id: 'urn:ietf:params:scim:schemas:core:2.0:Group', name: 'Group', attributes: [
      { name: 'displayName', type: 'string' }, { name: 'members', type: 'complex', multiValued: true }] },
    { id: GROUP_EXT, name: 'ExampleGroup', attributes: [
      { name: 'type', type: 'string' }, { name: 'description', type: 'string' }] },
  ];

  const resourceTypes = [
    { id: 'User', name: 'User', endpoint: '/Users', schema: 'urn:ietf:params:scim:schemas:core:2.0:User',
      schemaExtensions: [{ schema: USER_EXT, required: false }] },
    { id: 'Group', name: 'Group', endpoint: '/Groups', schema: 'urn:ietf:params:scim:schemas:core:2.0:Group',
      schemaExtensions: [{ schema: GROUP_EXT, required: false }] },
  ];

  const listResponse = (items, startIndex, count) => {
    const page = items.slice(startIndex - 1, startIndex - 1 + count);
    return {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: items.length,
      startIndex,
      itemsPerPage: page.length,
      Resources: page,
    };
  };

  const routes = (pathname, startIndex, count) => {
    if (pathname.endsWith('/ResourceTypes')) return listResponse(resourceTypes, 1, resourceTypes.length);
    if (pathname.endsWith('/Schemas')) return listResponse(schemas, 1, schemas.length);
    if (pathname.endsWith('/ServiceProviderConfig')) return { filter: { supported: true }, patch: { supported: false } };
    if (pathname.endsWith('/Users')) return listResponse(users, startIndex, count);
    if (pathname.endsWith('/Groups')) return listResponse(groups, startIndex, count);
    return null;
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://scim.invalid');
    const body = routes(
      url.pathname,
      parseInt(url.searchParams.get('startIndex') || '1', 10),
      parseInt(url.searchParams.get('count') || '100', 10),
    );
    const payload = JSON.stringify(body ?? { error: 'not found' });
    res.writeHead(body ? 200 : 404, {
      'Content-Type': 'application/scim+json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  });

  return {
    users,
    groups,
    // 0.0.0.0, not loopback: the API and worker containers reach this over the
    // Docker bridge, from outside this host's loopback namespace.
    listen: () => new Promise(resolve => server.listen(0, '0.0.0.0', () => resolve(server.address().port))),
    close: () => new Promise(resolve => server.close(() => resolve(undefined))),
  };
}

/**
 * Addresses a container might reach this host's mock server on, best first.
 *
 * `host.docker.internal` is what docker-compose.ci.yml wires up (extra_hosts) and
 * what Test-ScimCrawler.ps1 uses, but a plain `docker compose up` stack has no
 * such alias — there the bridge gateway address is what works, and the host side
 * of that bridge shows up here as a non-internal IPv4 interface.
 */
function candidateHosts() {
  const hosts = [];
  if (process.env.E2E_CONNECTOR_HOST) hosts.push(process.env.E2E_CONNECTOR_HOST);
  hosts.push('host.docker.internal');
  for (const addresses of Object.values(networkInterfaces() || {})) {
    for (const addr of addresses || []) {
      if (addr.family === 'IPv4' && !addr.internal) hosts.push(addr.address);
    }
  }
  return hosts;
}

const postJson = (path, body) => fetch(`${API}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const getJson = (path) => fetch(`${API}${path}`).then(r => (r.ok ? r.json() : null)).catch(() => null);

/** The connector config, minus the bits that differ per test. */
const connectorConfig = (baseUrl) => ({
  baseUrl,
  // The mock is plain http on a private address; without both opt-ins the SSRF
  // guard refuses it (SEC-2026-09 M-03) and nothing below would run.
  allowPrivateNetwork: true,
  allowInsecureHttp: true,
  authMethod: 'BasicAuth',
  username: 'scim',
  password: 'test',
});

/**
 * The first candidate host the API container can actually fetch the mock from,
 * probed through the wizard's own live-discovery endpoint — which is both the
 * cheapest reachability test available and the discovery response the assertions
 * below need anyway. Returns { baseUrl, discovery } or null.
 */
async function reachableEndpoint(port) {
  for (const host of candidateHosts()) {
    const baseUrl = `http://${host}:${port}`;
    const res = await postJson('/admin/crawlers/scim/discover', { config: connectorConfig(baseUrl) }).catch(() => null);
    if (!res || !res.ok) continue;
    const discovery = await res.json().catch(() => null);
    if (discovery?.groupAttributes?.length) return { baseUrl, discovery };
  }
  return null;
}

/** Poll a crawler job to a terminal state. Returns the final job row. */
async function waitForJob(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let job = null;
  while (Date.now() < deadline) {
    job = await getJson(`/admin/crawler-jobs/${id}`);
    if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return job;
}

export function register(test, expect) {
  test.describe('SCIM 2.0 crawler — group attribute sync (#1209)', () => {
    // Scoped inside the describe: every crawler's *.e2e.mjs registers into the
    // single app/ui/e2e/crawler-plugin-tests.spec.js file, so a file-level hook
    // would also fire for other crawlers' tests.
    let restoreExperimental = async () => {};
    test.beforeAll(async () => { restoreExperimental = await enableFeatureFlag('experimentalCrawlers'); });
    test.afterAll(async () => {
      await deleteCrawlerConfigs(name => name.startsWith(CONFIG_PREFIX));
      await restoreExperimental();
    });

    test('extension-schema group attributes reach the group instead of syncing empty', async ({ page }) => {
      // A crawl is queued, picked up by the worker and run end to end — minutes,
      // not the 30s default, and the worker takes jobs one at a time so this can
      // sit behind another crawler's run.
      test.setTimeout(300_000);

      const tag = `${Date.now().toString(36)}`;
      const mock = startMockScimProvider(tag);
      const port = await mock.listen();

      try {
        const endpoint = await reachableEndpoint(port);
        test.skip(!endpoint, 'the API container cannot reach a mock server on this host — no route to test over');
        if (!endpoint) return;

        // ── The root cause, asserted directly: discovery hands the wizard BARE
        // names for attributes the resource JSON nests under an extension URN.
        // Every group attribute on offer comes from the extension; the core
        // Group schema contributes none.
        expect(endpoint.discovery.groupAttributes).toEqual(['description', 'type']);
        expect(endpoint.discovery.userAttributes).toEqual(expect.arrayContaining(['costCenter', 'department']));

        // ── Configure the connector the way an operator leaving the wizard does:
        // both group attributes opted in, plus one user attribute so a regression
        // that only restored the Group path still fails here.
        const systemName = `${CONFIG_PREFIX}${tag}`;
        const created = await postJson('/admin/crawler-configs', {
          crawlerType: 'scim',
          displayName: systemName,
          config: {
            ...connectorConfig(endpoint.baseUrl),
            systemName,
            pageSize: 100,
            selectedObjects: { users: true, groups: true, groupMembers: true },
            selectedAttributes: { user: ['department'], group: ['description', 'type'] },
          },
        });
        expect(created.status, 'the connector config was accepted').toBe(201);
        const configId = (await created.json()).id;

        // ── Run it.
        const queued = await postJson('/admin/crawler-jobs', { jobType: 'scim', configId });
        expect(queued.status, 'the crawl was queued').toBe(201);
        const job = await waitForJob((await queued.json()).id, 280_000);
        expect(job?.status, `crawl finished (${job?.errorMessage || 'no error reported'})`).toBe('completed');

        // ── The group as the API now holds it.
        const systems = await getJson('/systems');
        const system = (Array.isArray(systems) ? systems : []).find(s => s.displayName === systemName);
        expect(system, 'the crawl registered its system').toBeTruthy();

        const resources = await getJson(`/resources?systemId=${system.id}&limit=50`);
        const rows = resources?.data || [];
        const group = rows.find(r => r.externalId === mock.groups[0].id);
        expect(group, `the crawled group is present (got ${rows.length} resource(s))`).toBeTruthy();

        // `description` is a core Resources column and `type` lands in
        // extendedAttributes, so the two together cover both destinations a
        // selected attribute can have — and BOTH were only ever served under the
        // extension URN, which is what makes them fail together when the
        // extension lookup is missing rather than just reading blank.
        expect(group.description).toBe(mock.groups[0][GROUP_EXT].description);
        expect(group.extendedAttributes?.type).toBe('security');

        // The same lookup on the User side — a fix that only restored the Group
        // path would leave this one undefined. (`search` matches displayName, not
        // userName, so it is the tag that finds the row.)
        const principals = await getJson(`/users?search=${tag}&limit=10`);
        const principal = (principals?.data || []).find(p => p.externalId === mock.users[0].id);
        expect(principal?.department).toBe('Finance');

        // ── And what the analyst actually opens. The reported symptom was an
        // attribute that "isn't there", so the assertion is that the group's own
        // detail page renders the name and the value.
        await page.goto(`${BASE}/#group:${group.id}`);
        await expect(page.getByRole('heading', { name: `Group ${tag}` }).first()).toBeVisible({ timeout: 30000 });
        const attributes = page.locator('table').first();
        await expect(attributes).toContainText('type');
        await expect(attributes).toContainText('security');
        await expect(attributes).toContainText(mock.groups[0][GROUP_EXT].description);
      } finally {
        await mock.close();
      }
    });
  });
}
