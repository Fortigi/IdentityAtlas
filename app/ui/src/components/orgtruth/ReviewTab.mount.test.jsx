// @vitest-environment jsdom
//
// Organisation → Review against stubbed routes: grouping per entity, the
// decision buttons only for an importer, Confirm / Reject / Move / Undo reaching
// PUT|DELETE /links/:id/override then refetching, failures inline, the filter,
// and the empty and 501 states.
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, waitFor, within } from '@ui/test-utils/renderWithProviders';
import ReviewTab from './ReviewTab';

const IMPORTER = { hasWildcard: false, permissions: new Set(['data.read', 'data.write.contexts']) };
const READER = { hasWildcard: false, permissions: new Set(['data.read']) };

const ALICE = { id: 'e1', entityType: 'Person', displayName: 'Alice Contoso' };
const PORTAL = { id: 'e2', entityType: 'Project', displayName: 'Northwind Portal' };
const REVIEW = {
  data: [
    { link: { id: 'l1', confidence: 45, status: 'proposed', signals: 'name' }, entity: ALICE, target: { targetType: 'Principal', id: 'u1', label: 'alice.c' },
      candidates: [{ id: 'l2', targetType: 'Principal', targetId: 'u2', label: 'alice.contoso', confidence: 70, status: 'proposed', signals: 'email,name' }] },
    { link: { id: 'l3', confidence: 55, status: 'proposed', signals: 'token', analystOverride: 'rejected' }, entity: PORTAL, target: { targetType: 'Resource', id: 'g1', label: 'GRP-Portal' }, candidates: [] },
  ],
  total: 2,
};

function render({ auth = IMPORTER, review = REVIEW, override = { ok: true } } = {}) {
  const authFetch = makeAuthFetch((url, opts) => {
    if (url.startsWith('/api/org-truth/model')) return { entityTypes: [{ type: 'Person', count: 60 }, { type: 'Project', count: 87 }] };
    if (url.startsWith('/api/org-truth/review')) return review;
    if (url.includes('/override')) return typeof override === 'function' ? override(url, opts) : override;
    return undefined;
  });
  const onOpenDetail = vi.fn();
  renderWithProviders(<ReviewTab onOpenDetail={onOpenDetail} />, { auth: { authFetch, ...auth }, features: { orgTruth: true } });
  return { authFetch, onOpenDetail };
}

const reviewCalls = (af) => af.mock.calls.filter(c => c[0].startsWith('/api/org-truth/review')).length;
const overrideCalls = (af) => af.mock.calls.filter(c => c[0].includes('/override'));
const group = async (name) => within(await screen.findByRole('region', { name }));
// The in-app prompt is a form holding the message, the textbox and its buttons.
const promptForm = async () => (await screen.findByRole('textbox')).closest('form');
const rowOf = (g, label) => within(g.getByRole('button', { name: label }).closest('tr'));

describe('ReviewTab', () => {
  it('groups candidates per entity, best first, with confidence and signal chips', async () => {
    render();
    const alice = await group('Alice Contoso');
    const targets = alice.getAllByRole('row').slice(1).map(r => r.cells[0].textContent);
    expect(targets).toEqual(['alice.contoso', 'alice.c']);
    expect(alice.getByText('70%')).toBeInTheDocument();
    expect(rowOf(alice, 'alice.contoso').getByText('email')).toBeInTheDocument();
    expect(alice.getAllByText('Account')).toHaveLength(2);
    expect(alice.getByText('Person')).toBeInTheDocument();
  });

  it('confirms a candidate, toasts and refetches the queue', async () => {
    const { authFetch } = render();
    const alice = await group('Alice Contoso');
    const before = reviewCalls(authFetch);
    await userEvent.click(rowOf(alice, 'alice.contoso').getByRole('button', { name: 'Confirm' }));
    expect(overrideCalls(authFetch)[0]).toEqual(['/api/org-truth/links/l2/override',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"action":"confirmed"}' }]);
    expect(await screen.findByText('Link confirmed')).toBeInTheDocument();
    await waitFor(() => expect(reviewCalls(authFetch)).toBe(before + 1));
  });

  it('rejects, and undoes an earlier decision', async () => {
    const { authFetch } = render();
    const alice = await group('Alice Contoso');
    await userEvent.click(rowOf(alice, 'alice.c').getByRole('button', { name: 'Reject' }));
    expect(JSON.parse(overrideCalls(authFetch)[0][1].body)).toEqual({ action: 'rejected' });
    const portal = await group('Northwind Portal');
    const row = rowOf(portal, 'GRP-Portal');
    expect(row.queryByRole('button', { name: 'Confirm' })).toBeNull();
    await userEvent.click(row.getByRole('button', { name: 'Undo' }));
    expect(overrideCalls(authFetch)[1][1]).toEqual({ method: 'DELETE' });
  });

  it('moves a link to another shown candidate picked in the prompt', async () => {
    const { authFetch } = render();
    const alice = await group('Alice Contoso');
    await userEvent.click(rowOf(alice, 'alice.c').getByRole('button', { name: 'Move' }));
    const dialog = await promptForm();
    expect(dialog).toHaveTextContent('1. alice.contoso (70%)');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(overrideCalls(authFetch)).toHaveLength(1));
    expect(overrideCalls(authFetch)[0][0]).toBe('/api/org-truth/links/l1/override');
    expect(JSON.parse(overrideCalls(authFetch)[0][1].body)).toEqual({ action: 'moved', targetId: 'u2' });
  });

  it('refuses a move to something that is not a shown candidate, and a cancelled prompt does nothing', async () => {
    const { authFetch } = render();
    const alice = await group('Alice Contoso');
    await userEvent.click(rowOf(alice, 'alice.c').getByRole('button', { name: 'Move' }));
    const form = await promptForm();
    const input = within(form).getByRole('textbox');
    await userEvent.clear(input);
    await userEvent.type(input, 'someone else');
    await userEvent.click(within(form).getByRole('button', { name: 'Move' }));
    expect(await screen.findByText('That is not one of the shown candidates.')).toBeInTheDocument();
    await userEvent.click(rowOf(alice, 'alice.c').getByRole('button', { name: 'Move' }));
    await userEvent.click(within(await promptForm()).getByRole('button', { name: 'Cancel' }));
    expect(overrideCalls(authFetch)).toEqual([]);
    // A candidate with no other target of its type cannot be moved.
    expect(rowOf(await group('Northwind Portal'), 'GRP-Portal').queryByRole('button', { name: 'Move' })).toBeNull();
  });

  it('shows a failed decision inline', async () => {
    render({ override: jsonResponse({ error: 'Link not found' }, { ok: false, status: 404 }) });
    const alice = await group('Alice Contoso');
    await userEvent.click(rowOf(alice, 'alice.c').getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The decision was not saved: Link not found');
  });

  it('opens the entity and the target detail tabs', async () => {
    const { onOpenDetail } = render();
    const alice = await group('Alice Contoso');
    await userEvent.click(alice.getByRole('button', { name: 'Alice Contoso' }));
    expect(onOpenDetail).toHaveBeenCalledWith('org-entity', 'e1', 'Alice Contoso');
    await userEvent.click(alice.getByRole('button', { name: 'alice.c' }));
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'u1', 'alice.c');
    await userEvent.click((await group('Northwind Portal')).getByRole('button', { name: 'GRP-Portal' }));
    expect(onOpenDetail).toHaveBeenCalledWith('resource', 'g1', 'GRP-Portal');
  });

  it('is read-only for a reader', async () => {
    render({ auth: READER });
    const alice = await group('Alice Contoso');
    expect(alice.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.getByText(/deciding on a link needs permission/)).toBeInTheDocument();
  });

  it('filters by entity type and resets to the first page', async () => {
    const { authFetch } = render();
    await group('Alice Contoso');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Entity type' }), 'Project');
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/org-truth/review?status=proposed&entityType=Project&page=1'));
  });

  it('shows an empty queue', async () => {
    render({ review: { data: [], total: 0 } });
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument();
  });

  it('renders a 501 as not available yet', async () => {
    render({ review: jsonResponse({}, { ok: false, status: 501 }) });
    expect(await screen.findByText('Review — not available yet')).toBeInTheDocument();
  });
});
