// @vitest-environment jsdom
//
// The org-entity detail tab against stubbed GET /entities/:id and /graph: the
// header with Download, attributes, relations in and out, links with the
// permission-gated decisions, the graph ring from `categories`, the tab
// relabel, and the 404 / 501 / missing-graph paths.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, makeAuthFetch, jsonResponse, blobResponse, screen, userEvent, waitFor, within } from '@ui/test-utils/renderWithProviders';

vi.mock('@ui/utils/download', async (orig) => ({ ...(await orig()), triggerDownload: vi.fn() }));
const { triggerDownload } = await import('@ui/utils/download');
const { default: OrgEntityDetailPage } = await import('./OrgEntityDetailPage');

const IMPORTER = { hasWildcard: false, permissions: new Set(['data.read', 'data.write.contexts']) };
const READER = { hasWildcard: false, permissions: new Set(['data.read']) };

const ENTITY = {
  id: 'e1', entityType: 'Project', displayName: 'Northwind Portal', canonicalKey: 'nw-portal', status: 'accepted',
  origin: 'import', confidence: null, observedAt: '2026-10-01T09:00:00Z', validFrom: '2026-10-01T09:00:00Z', validTo: '2026-10-05T00:00:00Z',
  sourceLocator: 'row:17', attributes: { budget: '120000', costCenter: 'CC-42' },
  source: { id: 's1', displayName: 'Contoso projects', kind: 'list', fileName: 'projects.xlsx' },
  run: { id: 'r1', mode: 'full', finishedAt: '2026-10-01T10:00:00Z' },
  relations: {
    out: [{ id: 'rel1', predicate: 'owner', status: 'accepted', to: { id: 'e2', entityType: 'Person', displayName: 'Alice Contoso' } }],
    in: [{ id: 'rel2', predicate: 'partOf', status: 'proposed', from: { id: 'e3', entityType: 'Asset', displayName: 'Portal DB' } }],
  },
  links: [
    { id: 'l1', targetType: 'Resource', targetId: 'g1', label: 'GRP-Portal', confidence: 90, status: 'accepted', analystOverride: null, signals: 'name', matchedField: 'displayName', matchedValue: 'Portal' },
    { id: 'l2', targetType: 'Context', targetId: 'c1', label: 'Portal team', confidence: 40, status: 'proposed', analystOverride: null, signals: 'token' },
  ],
};
const GRAPH = {
  core: { id: 'e1', entityType: 'Project', displayName: 'Northwind Portal' },
  categories: [{ key: 'rel:out:owner', label: 'owner →', count: 1 }, { key: 'link:Resource', label: 'Resources', count: 1 }],
};

const EVIDENCE = {
  entity: { id: 'e1', entityType: 'Project', displayName: 'Northwind Portal' },
  people: [{ via: 'owner', principals: [{ principalId: 'p9', label: 'Dana Contoso', worked: false, rows: 0, hours: 0, lastPeriod: null }] }],
  activity: null,
  workedNotListed: [],
};

function render({ auth = IMPORTER, entity = ENTITY, graph = GRAPH, override = { ok: true }, evidence = EVIDENCE } = {}) {
  const authFetch = makeAuthFetch({
    '/download': blobResponse('bytes', { filename: 'projects.xlsx' }),
    'category=rel%3Aout%3Aowner': { items: [{ key: 'org-entity:e2', label: 'Alice Contoso', entityKind: 'org-entity', entityId: 'e2', entityType: 'Person' }] },
    'category=link%3AResource': { items: [{ key: 'resource:g1', label: 'GRP-Portal', entityKind: 'resource', entityId: 'g1', resourceType: 'Resource' }] },
    '/override': override,
    '/entities/e1/graph': graph,
    '/entities/e1/evidence': evidence,
    '/api/org-truth/entities/e1': entity,
  });
  const onOpenDetail = vi.fn();
  const onClose = vi.fn();
  const onCacheData = vi.fn();
  renderWithProviders(
    <OrgEntityDetailPage entityId="e1" onOpenDetail={onOpenDetail} onClose={onClose} onCacheData={onCacheData} />,
    { auth: { authFetch, ...auth }, features: { orgTruth: true } },
  );
  return { authFetch, onOpenDetail, onClose, onCacheData };
}

beforeEach(() => triggerDownload.mockClear());

describe('OrgEntityDetailPage', () => {
  it('shows the header, attributes and relabels its tab', async () => {
    const { onCacheData } = render();
    expect(await screen.findByRole('heading', { level: 2, name: 'Northwind Portal' })).toBeInTheDocument();
    expect(screen.getByText(/from Contoso projects \(row:17\)/)).toBeInTheDocument();
    expect(screen.getAllByText('closed').length).toBeGreaterThan(0);
    expect(screen.getByText('nw-portal')).toBeInTheDocument();
    expect(screen.getByText('CC-42')).toBeInTheDocument();
    await waitFor(() => expect(onCacheData).toHaveBeenCalledWith('e1', 'org-entity', ENTITY));
  });

  it('downloads the source and closes', async () => {
    const { authFetch, onClose } = render();
    await userEvent.click(await screen.findByRole('button', { name: 'Download source' }));
    expect(authFetch).toHaveBeenCalledWith('/api/org-truth/sources/s1/download');
    expect(triggerDownload).toHaveBeenCalledWith('projects.xlsx', expect.any(Blob));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('lists relations both ways; each opens the related entity', async () => {
    const { onOpenDetail } = render();
    await userEvent.click(await screen.findByRole('button', { name: 'Alice Contoso' }));
    expect(onOpenDetail).toHaveBeenCalledWith('org-entity', 'e2', 'Alice Contoso');
    const outgoing = screen.getByRole('button', { name: 'Alice Contoso' }).closest('li');
    expect(within(outgoing).getByText('owner →')).toBeInTheDocument();
    expect(within(outgoing).queryByText('accepted')).toBeNull();
    const incoming = screen.getByRole('button', { name: 'Portal DB' }).closest('li');
    expect(within(incoming).getByText('← partOf')).toBeInTheDocument();
    expect(within(incoming).getByText('proposed')).toBeInTheDocument();
  });

  it('lists the links best first and opens their targets', async () => {
    const { onOpenDetail } = render();
    const target = await screen.findByRole('button', { name: 'GRP-Portal' });
    const rows = target.closest('tbody').querySelectorAll('tr');
    expect([...rows].map(r => r.cells[0].textContent)).toEqual(['GRP-PortaldisplayName: Portal', 'Portal team']);
    await userEvent.click(target);
    expect(onOpenDetail).toHaveBeenCalledWith('resource', 'g1', 'GRP-Portal');
    await userEvent.click(screen.getByRole('button', { name: 'Portal team' }));
    expect(onOpenDetail).toHaveBeenCalledWith('context', 'c1', 'Portal team');
  });

  it('confirms a link and reloads the entity', async () => {
    const { authFetch } = render();
    const row = (await screen.findByRole('button', { name: 'Portal team' })).closest('tr');
    const loads = () => authFetch.mock.calls.filter(c => c[0] === '/api/org-truth/entities/e1').length;
    const before = loads();
    await userEvent.click(within(row).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Link confirmed')).toBeInTheDocument();
    await waitFor(() => expect(loads()).toBe(before + 1));
  });

  it('shows a failed decision inline', async () => {
    render({ override: jsonResponse({}, { ok: false, status: 501 }) });
    const row = (await screen.findByRole('button', { name: 'Portal team' })).closest('tr');
    await userEvent.click(within(row).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reviewing links is not available yet.');
  });

  it('hides the decisions from a reader', async () => {
    render({ auth: READER });
    await screen.findByRole('button', { name: 'Portal team' });
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  it('draws the entity with its relations as labelled edges to its neighbours', async () => {
    const { onOpenDetail } = render();
    await screen.findByRole('button', { name: 'Resource GRP-Portal, press to expand' });
    const svg = screen.getByRole('group', { name: 'Relationship graph' });
    const edges = [...svg.querySelectorAll('[data-edge]')].map(e => `${e.getAttribute('data-edge')} ${e.textContent}`).sort();
    expect(edges).toEqual(['org-entity:e1->org-entity:e2 owner', 'resource:g1->org-entity:e1 linked']);
    expect(within(svg).getByRole('button', { name: 'Project Northwind Portal, expanded, press to collapse' })).toBeInTheDocument();
    await userEvent.click(within(svg).getByRole('link', { name: 'Open Alice Contoso' }));
    expect(onOpenDetail).toHaveBeenCalledWith('org-entity', 'e2', 'Alice Contoso');
  });

  it('keeps the page when the graph is not available, and says so', async () => {
    render({ graph: jsonResponse({}, { ok: false, status: 501 }), entity: { ...ENTITY, links: [], relations: undefined, source: null } });
    expect(await screen.findByText('The relationship graph is not available yet.')).toBeInTheDocument();
    expect(screen.getByText('Not linked to anything in the connected systems.')).toBeInTheDocument();
    expect(screen.getAllByText('None.')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Download source' })).toBeNull();
  });

  it('shows the evidence from other lists below the links', async () => {
    const { onOpenDetail } = render();
    expect(await screen.findByText('No other list refers to this entity')).toBeInTheDocument();
    expect(screen.getByText('Evidence from other lists')).toBeInTheDocument();
    const row = screen.getByRole('button', { name: 'Dana Contoso' }).closest('tr');
    expect(within(row).getByText('no hours found')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Dana Contoso' }));
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'p9', 'Dana Contoso');
  });

  it('leaves the evidence out when there is none', async () => {
    render({ evidence: { ...EVIDENCE, people: [] } });
    await screen.findByRole('button', { name: 'Portal team' });
    await waitFor(() => expect(screen.queryByText('Loading evidence…')).toBeNull());
    expect(screen.queryByText('Evidence from other lists')).toBeNull();
  });

  it('renders not found on a 404 and not available yet on a 501', async () => {
    const { onClose } = render({ entity: jsonResponse({ error: 'not found' }, { ok: false, status: 404 }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByText('Entity not found')).toBeInTheDocument();
  });

  it('renders a 501 as not available yet', async () => {
    render({ entity: jsonResponse({}, { ok: false, status: 501 }) });
    expect(await screen.findByText('Entity — not available yet')).toBeInTheDocument();
  });
});
