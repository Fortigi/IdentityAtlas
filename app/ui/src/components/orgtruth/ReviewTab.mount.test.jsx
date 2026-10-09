// @vitest-environment jsdom
//
// Organisation → Review against stubbed routes: one card per distinct decision
// (GET /review/groups), Confirm / Reject / Reject all sending the exact
// PUT /review/groups/decision body then reloading, the toast, failures inline,
// read-only for readers and for decided statuses, the filters, empty and 501.
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, waitFor, within } from '@ui/test-utils/renderWithProviders';
import ReviewTab from './ReviewTab';

const IMPORTER = { hasWildcard: false, permissions: new Set(['data.read', 'data.write.contexts']) };
const READER = { hasWildcard: false, permissions: new Set(['data.read']) };

const HARBOUR = {
  entityType: 'Hours', via: 'customer', value: 'Contoso Harbour Ltd.', targetType: 'OrgEntity', entities: 42, bestConfidence: 70,
  candidates: [
    { targetId: 'c2', label: 'Harbour Holding', confidence: 55, entities: 42 },
    { targetId: 'c1', label: 'Contoso Harbour', confidence: 70, entities: 42 },
  ],
};
const PORTAL = {
  entityType: 'Project', via: 'displayName', value: 'Northwind Portal', targetType: 'Resource', entities: 1, bestConfidence: 80,
  candidates: [{ targetId: 'g1', label: 'GRP-Portal', confidence: 80, entities: 1 }],
};
const GROUPS = { kind: 'groups', status: 'proposed', page: 1, pageSize: 50, total: 2, rows: [HARBOUR, PORTAL] };
const HARBOUR_TITLE = 'Hours · customer = “Contoso Harbour Ltd.”';

function render({ auth = IMPORTER, groups = GROUPS, decision = { accepted: 42, rejected: 42 } } = {}) {
  const authFetch = makeAuthFetch((url, opts) => {
    if (url.startsWith('/api/org-truth/model')) return { entityTypes: [{ type: 'Project', count: 87 }, { type: 'Asset', count: 3 }] };
    if (url === '/api/org-truth/review/groups/decision') return typeof decision === 'function' ? decision(url, opts) : decision;
    if (url.startsWith('/api/org-truth/review/groups')) return groups;
    return undefined;
  });
  const onOpenDetail = vi.fn();
  renderWithProviders(<ReviewTab onOpenDetail={onOpenDetail} />, { auth: { authFetch, ...auth }, features: { orgTruth: true } });
  return { authFetch, onOpenDetail };
}

const groupCalls = (af) => af.mock.calls.filter(c => c[0].startsWith('/api/org-truth/review/groups?')).length;
const decisionCalls = (af) => af.mock.calls.filter(c => c[0] === '/api/org-truth/review/groups/decision');
const card = async (name) => within(await screen.findByRole('region', { name }));

describe('ReviewTab', () => {
  it('renders one card per group with its rows, target kind and candidates best first', async () => {
    render();
    const harbour = await card(HARBOUR_TITLE);
    expect(harbour.getByText('42 rows · links to another list')).toBeInTheDocument();
    const names = harbour.getAllByRole('listitem').map(li => li.textContent);
    expect(names[0]).toMatch(/^Contoso Harbour/);
    expect(names[1]).toMatch(/^Harbour Holding/);
    expect(harbour.getByText('70%')).toBeInTheDocument();
    expect(harbour.getAllByText('42 rows')).toHaveLength(2);
    const portal = await card('Project · name = “Northwind Portal”');
    expect(portal.getByText('1 row · links to Group')).toBeInTheDocument();
    expect(screen.getAllByRole('region')).toHaveLength(2);
  });

  it('confirms a candidate with the exact body, toasts and reloads', async () => {
    const { authFetch } = render();
    const harbour = await card(HARBOUR_TITLE);
    const before = groupCalls(authFetch);
    await userEvent.click(harbour.getByRole('button', { name: 'Confirm Contoso Harbour for “Contoso Harbour Ltd.”' }));
    expect(decisionCalls(authFetch)).toEqual([['/api/org-truth/review/groups/decision', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityType: 'Hours', via: 'customer', value: 'Contoso Harbour Ltd.', targetType: 'OrgEntity', action: 'confirmed', targetId: 'c1' }),
    }]]);
    expect(await screen.findByText('42 rows linked to Contoso Harbour')).toBeInTheDocument();
    await waitFor(() => expect(groupCalls(authFetch)).toBe(before + 1));
  });

  it('rejects one candidate, and rejects the whole group', async () => {
    const { authFetch } = render({ decision: { accepted: 0, rejected: 42 } });
    const harbour = await card(HARBOUR_TITLE);
    await userEvent.click(harbour.getByRole('button', { name: 'Reject Harbour Holding for “Contoso Harbour Ltd.”' }));
    expect(JSON.parse(decisionCalls(authFetch)[0][1].body)).toEqual(
      { entityType: 'Hours', via: 'customer', value: 'Contoso Harbour Ltd.', targetType: 'OrgEntity', action: 'rejected', targetId: 'c2' });
    expect(await screen.findByText('42 rows rejected for Harbour Holding')).toBeInTheDocument();
    await userEvent.click(harbour.getByRole('button', { name: 'Reject all for “Contoso Harbour Ltd.”' }));
    await waitFor(() => expect(decisionCalls(authFetch)).toHaveLength(2));
    expect(JSON.parse(decisionCalls(authFetch)[1][1].body)).toEqual(
      { entityType: 'Hours', via: 'customer', value: 'Contoso Harbour Ltd.', targetType: 'OrgEntity', action: 'rejected' });
    expect(await screen.findByText('42 rows rejected')).toBeInTheDocument();
  });

  it('shows a failed decision inline and does not reload', async () => {
    const { authFetch } = render({ decision: jsonResponse({ error: 'No open proposal for that value and target.' }, { ok: false, status: 404 }) });
    const harbour = await card(HARBOUR_TITLE);
    const before = groupCalls(authFetch);
    await userEvent.click(harbour.getByRole('button', { name: 'Confirm Contoso Harbour for “Contoso Harbour Ltd.”' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The decision was not saved: No open proposal for that value and target.');
    expect(groupCalls(authFetch)).toBe(before);
  });

  it('shows a network failure inline', async () => {
    render({ decision: () => { throw new Error('offline'); } });
    const harbour = await card(HARBOUR_TITLE);
    await userEvent.click(harbour.getByRole('button', { name: 'Reject all for “Contoso Harbour Ltd.”' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The decision was not saved: offline');
  });

  it('opens a candidate\'s detail tab', async () => {
    const { onOpenDetail } = render();
    await userEvent.click((await card(HARBOUR_TITLE)).getByRole('button', { name: 'Contoso Harbour' }));
    expect(onOpenDetail).toHaveBeenCalledWith('org-entity', 'c1', 'Contoso Harbour');
    await userEvent.click((await card('Project · name = “Northwind Portal”')).getByRole('button', { name: 'GRP-Portal' }));
    expect(onOpenDetail).toHaveBeenCalledWith('resource', 'g1', 'GRP-Portal');
  });

  it('is read-only for a reader', async () => {
    render({ auth: READER });
    const harbour = await card(HARBOUR_TITLE);
    expect(harbour.queryByRole('button', { name: /^Confirm/ })).toBeNull();
    expect(harbour.queryByRole('button', { name: /^Reject/ })).toBeNull();
    expect(screen.getByText(/deciding on a link needs permission/)).toBeInTheDocument();
  });

  it('shows decided groups read-only and resets to the first page on a filter', async () => {
    const { authFetch } = render();
    await card(HARBOUR_TITLE);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'accepted');
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/org-truth/review/groups?status=accepted&page=1'));
    const harbour = await card(HARBOUR_TITLE);
    await waitFor(() => expect(harbour.queryByRole('button', { name: /^Confirm/ })).toBeNull());
    expect(harbour.queryByRole('button', { name: /^Reject all/ })).toBeNull();
    expect(screen.queryByText(/deciding on a link needs permission/)).toBeNull();
  });

  it('filters by entity type from the model and the groups', async () => {
    const { authFetch } = render();
    await card(HARBOUR_TITLE);
    const select = screen.getByRole('combobox', { name: 'Entity type' });
    await waitFor(() => expect(within(select).getAllByRole('option').map(o => o.textContent))
      .toEqual(['All types', 'Asset', 'Hours', 'Project']));
    await userEvent.selectOptions(select, 'Hours');
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/org-truth/review/groups?status=proposed&entityType=Hours&page=1'));
  });

  it('pages through the groups', async () => {
    const { authFetch } = render({ groups: { ...GROUPS, total: 120 } });
    await card(HARBOUR_TITLE);
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/org-truth/review/groups?status=proposed&page=2'));
  });

  it('shows an empty queue', async () => {
    render({ groups: { ...GROUPS, total: 0, rows: [] } });
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument();
  });

  it('renders a 501 as not available yet', async () => {
    render({ groups: jsonResponse({}, { ok: false, status: 501 }) });
    expect(await screen.findByText('Review — not available yet')).toBeInTheDocument();
  });
});
