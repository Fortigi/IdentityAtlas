// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement as h } from 'react';
import ContextDetailPage from './ContextDetailPage';
import { SharedViewContext } from '@ui/contexts/SharedViewContext';
import {
  renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent, within,
} from '@ui/test-utils/renderWithProviders';

// The two readers of one page (decided 2026-10-20): without
// data.write.contexts the business view, with it the analyst view.

beforeEach(() => {
  global.fetch = vi.fn(async () => jsonResponse({ riskScoring: true }));
});
afterEach(() => { vi.restoreAllMocks(); });

const READER = { hasWildcard: false, permissions: new Set(['data.read']) };

const UNIT = {
  id: 'ctx-1', variant: 'generated', targetType: 'Principal', contextType: 'Department', contextCategory: 'OrganizationalUnit',
  displayName: 'Engineering', sourceAlgorithmName: 'department-from-principal', sourceAlgorithmDisplayName: 'Department from Principal', scopeSystemName: 'Demo EntraID',
  directMemberCount: 2, totalMemberCount: 5, userRenamed: false, lastCalculatedAt: '2026-10-20T12:06:02.810942+00:00',
  parentContextId: 'ctx-parent', parentDisplayName: 'Engineering Dept',
};
const MEMBERS = { total: 2, data: [
  { id: 'm-1', displayName: 'Alice Engineer', jobTitle: 'Staff Engineer', principalType: 'User', addedBy: 'algorithm' },
  { id: 'm-2', displayName: 'Bob Builder', jobTitle: 'Engineer', principalType: 'Guest', addedBy: 'analyst' },
] };

// Ordered: specific keys before the bare detail key (substring match).
function routes(overrides = {}) {
  return makeAuthFetch({
    '/api/contexts/ctx-1/members': MEMBERS,
    '/api/contexts/ctx-1/timeline': { events: [], sinceDays: 90 },
    '/api/contexts/ctx-1/relationships': [],
    '/api/contexts/ctx-1/roles/suggestion': jsonResponse(undefined, { status: 204 }),
    '/api/contexts/ctx-1/roles': [],
    '/api/contexts/ctx-parent': { attributes: { id: 'ctx-parent', displayName: 'Engineering Dept', parentContextId: 'ctx-root', parentDisplayName: 'Corp' } },
    '/api/contexts/ctx-root': { attributes: { id: 'ctx-root', displayName: 'Fortigi Demo Corp' } },
    '/api/contexts/ctx-1': { attributes: UNIT, subContexts: [{ id: 'ctx-child', displayName: 'Platform', memberCount: 3 }] },
    '/api/risk-scores/contexts/ctx-1': { riskScore: 50 },
    ...overrides,
  });
}

// The same unit, created here: the only kind whose member edits last.
const manualUnit = () => routes({ '/api/contexts/ctx-1': { attributes: { ...UNIT, variant: 'manual' }, subContexts: [] } });

function mount(props = {}, auth = {}, wrap = (x) => x) {
  const onOpenDetail = vi.fn();
  const onClose = vi.fn();
  const authFetch = auth.authFetch || routes();
  const result = renderWithProviders(wrap(h(ContextDetailPage, { contextId: 'ctx-1', onClose, onOpenDetail, ...props })), { auth: { authFetch, ...auth } });
  return { ...result, authFetch, onOpenDetail, onClose, user: userEvent.setup() };
}

describe('the business view (no data.write.contexts)', () => {
  it('shows the facts and members, without Edit, Timeline, raw details, member edit or a Close', async () => {
    const { authFetch } = mount({}, READER);
    expect(await screen.findByText('Alice Engineer')).toBeInTheDocument();
    expect(screen.getByTestId('context-subtitle')).toHaveTextContent('Department · derived by the Department from Principal rule');
    for (const name of ['Edit', 'Add sub-unit', 'Edit members', 'Back to Contexts']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    const details = screen.getByRole('region', { name: 'More details' });
    expect([...details.querySelectorAll('dt')].map(d => d.textContent)).toEqual(['Last updated']);
    expect(authFetch).not.toHaveBeenCalledWith(expect.stringContaining('/timeline'));
  });

  it('a shared read-only view is a business view even with write permission', async () => {
    mount({}, {}, (ui) => h(SharedViewContext.Provider, { value: true }, ui));
    await screen.findByText('Alice Engineer');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Timeline' })).toBeNull();
    // Not an owner's page: no references to expand, and no sub-unit or parent links.
    expect(screen.queryByRole('button', { name: 'Alice Engineer' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Platform/ })).toBeNull();
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).queryByRole('button')).toBeNull();
  });

  it('builds the breadcrumb from the parent chain, each parent opening its page', async () => {
    const { onOpenDetail, user } = mount({}, READER);
    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    await waitFor(() => expect(within(crumbs).getAllByRole('button').map(b => b.textContent)).toEqual(['Fortigi Demo Corp', 'Engineering Dept']));
    await user.click(within(crumbs).getByRole('button', { name: 'Fortigi Demo Corp' }));
    expect(onOpenDetail).toHaveBeenCalledWith('context', 'ctx-root', 'Fortigi Demo Corp');
    expect(screen.queryByText(/^Parent:/)).toBeNull();
  });

  it('stops the breadcrumb at a parent it cannot read, keeping the name it has', async () => {
    mount({}, { ...READER, authFetch: routes({ '/api/contexts/ctx-parent': jsonResponse({}, { ok: false, status: 403 }) }) });
    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    await waitFor(() => expect(crumbs).toHaveTextContent(/^Engineering Dept›$/));
  });

  it('copies the page link', async () => {
    const writeText = vi.fn(async () => {});
    const { user } = mount({}, READER);
    // After userEvent.setup(), which installs a clipboard of its own.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/#context:ctx-1$/));
    expect(await screen.findByText('Link copied')).toBeInTheDocument();
  });

  it('says so when the link cannot be copied', async () => {
    const { user } = mount({}, READER);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied'); }) }, configurable: true });
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect(await screen.findByText('Could not copy the link')).toBeInTheDocument();
  });
});

describe('the page title', () => {
  it('is the unit name while the standalone page is open, and restored after', async () => {
    document.title = 'Identity Atlas';
    const { unmount } = mount({}, READER);
    await waitFor(() => expect(document.title).toBe('Engineering'));
    unmount();
    expect(document.title).toBe('Identity Atlas');
  });

  it('is left alone when embedded in the Contexts page', async () => {
    document.title = 'Identity Atlas';
    mount({ embedded: true });
    await screen.findByText('Alice Engineer');
    expect(document.title).toBe('Identity Atlas');
  });
});

describe('the analyst view', () => {
  it('adds Edit, Add sub-unit, the Timeline and Back to Contexts', async () => {
    const { onClose, user } = mount();
    await screen.findByText('Alice Engineer');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map(t => t.textContent.replace(/\d+$/, ''))).toEqual(['Members', 'Timeline', 'Diff', 'Risk']);
    await user.click(screen.getByRole('button', { name: 'Back to Contexts' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('reads members by default; on a unit created here "Edit members" adds the add box and Remove on every row', async () => {
    const { user } = mount({}, { authFetch: manualUnit() });
    const alice = (await screen.findByText('Alice Engineer')).closest('tr');
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /to add/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Edit members' }));
    expect(screen.getByRole('textbox', { name: 'Search accounts to add' })).toBeInTheDocument();
    expect(screen.queryByTestId('member-edit-note')).toBeNull();
    // Whoever added them, a removal from a unit created here lasts.
    expect(within(alice).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(within(screen.getByText('Bob Builder').closest('tr')).getByRole('button', { name: 'Remove' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('offers no member edit on a derived unit, where removed members would come back', async () => {
    mount();
    await screen.findByText('Alice Engineer');
    expect(screen.queryByRole('button', { name: 'Edit members' })).toBeNull();
    // The unit itself still takes a new name or a sub-unit.
    expect(screen.getByRole('button', { name: 'Add sub-unit' })).toBeInTheDocument();
  });

  it('Remove deletes the member and re-reads the list', async () => {
    const { authFetch, user } = mount({}, { authFetch: manualUnit() });
    await screen.findByText('Bob Builder');
    await user.click(screen.getByRole('button', { name: 'Edit members' }));
    const reads = () => authFetch.mock.calls.filter(([u]) => String(u).startsWith('/api/contexts/ctx-1/members?')).length;
    const before = reads();
    await user.click(within(screen.getByText('Bob Builder').closest('tr')).getByRole('button', { name: 'Remove' }));
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/ctx-1/members/m-2', expect.objectContaining({ method: 'DELETE' }));
    await waitFor(() => expect(reads()).toBe(before + 1));
  });

  it('offers no Remove with sub-units included', async () => {
    const { user } = mount({}, { authFetch: manualUnit() });
    await screen.findByText('Bob Builder');
    await user.click(screen.getByLabelText('Include sub-units'));
    await user.click(screen.getByRole('button', { name: 'Edit members' }));
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('offers no member edit on an imported unit', async () => {
    mount({}, { authFetch: routes({ '/api/contexts/ctx-1': { attributes: { ...UNIT, variant: 'synced' }, subContexts: [] } }) });
    await screen.findByText('Alice Engineer');
    expect(screen.queryByRole('button', { name: 'Edit members' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add sub-unit' })).toBeNull();
  });

  it('Add sub-unit asks a name and creates it under this unit', async () => {
    const authFetch = routes({ '/api/contexts': undefined });
    const fetchWithPost = vi.fn(async (url, opts = {}) => (opts.method === 'POST'
      ? jsonResponse({ id: 'new', ...JSON.parse(opts.body) })
      : authFetch(url, opts)));
    const { user } = mount({}, { authFetch: fetchWithPost });
    await screen.findByText('Alice Engineer');
    await user.click(screen.getByRole('button', { name: 'Add sub-unit' }));
    const form = (await screen.findByText('Name of the new unit under Engineering')).closest('form');
    await user.type(within(form).getByRole('textbox'), 'Platform Team');
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(fetchWithPost).toHaveBeenCalledWith('/api/contexts', expect.objectContaining({ method: 'POST' })));
    const body = JSON.parse(fetchWithPost.mock.calls.find(([, o]) => o?.method === 'POST')[1].body);
    expect(body).toMatchObject({ displayName: 'Platform Team', parentContextId: 'ctx-1', targetType: 'Principal', contextCategory: 'OrganizationalUnit' });
  });

  it('Add sub-unit shows the API refusal, and a cancel creates nothing', async () => {
    const authFetch = routes();
    const refusing = vi.fn(async (url, opts = {}) => (opts.method === 'POST'
      ? jsonResponse({ error: 'name taken' }, { ok: false, status: 409 })
      : authFetch(url, opts)));
    const { user } = mount({}, { authFetch: refusing });
    await screen.findByText('Alice Engineer');
    await user.click(screen.getByRole('button', { name: 'Add sub-unit' }));
    let form = (await screen.findByText('Name of the new unit under Engineering')).closest('form');
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(refusing).not.toHaveBeenCalledWith('/api/contexts', expect.anything());

    await user.click(screen.getByRole('button', { name: 'Add sub-unit' }));
    form = (await screen.findByText('Name of the new unit under Engineering')).closest('form');
    await user.type(within(form).getByRole('textbox'), 'Dup');
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('name taken')).toBeInTheDocument();
  });

  it('the member count in the facts goes back to the members from the Timeline', async () => {
    const { user } = mount();
    await screen.findByText('Alice Engineer');
    await user.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(screen.queryByText('Alice Engineer')).toBeNull();
    await user.click(screen.getByRole('button', { name: '2 in this unit · 5 including sub-units' }));
    expect(await screen.findByText('Alice Engineer')).toBeInTheDocument();
  });
});

describe('the members table', () => {
  it('hides a column empty for every row on the page, and shows account types in words', async () => {
    mount({}, READER);
    const row = (await screen.findByText('Alice Engineer')).closest('tr');
    const headers = [...row.closest('table').querySelectorAll('th')].map(t => t.textContent);
    expect(headers).toEqual(['Name', 'Job title', 'Type']);
    expect([...row.cells].map(c => c.textContent)).toEqual(['Alice Engineer', 'Staff Engineer', 'Member']);
    expect(screen.getByText('Bob Builder').closest('tr')).toHaveTextContent('Guest');
  });

  it('keeps a column one row fills, leaving the other rows\' cells empty', async () => {
    const members = { total: 2, data: [{ id: 'a', displayName: 'A', email: 'a@x.com' }, { id: 'b', displayName: 'B' }] };
    mount({}, { ...READER, authFetch: routes({ '/api/contexts/ctx-1/members': members }) });
    const b = (await screen.findByText('B')).closest('tr');
    expect([...b.closest('table').querySelectorAll('th')].map(t => t.textContent)).toEqual(['Name', 'Email']);
    expect([...b.cells].map(c => c.textContent)).toEqual(['B', '']);
  });
});
