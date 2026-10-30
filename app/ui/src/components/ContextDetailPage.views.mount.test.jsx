// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Organisation knowledge (Admin → Experimental) is off by default; on here unless a test switches it off.
const knowledge = vi.hoisted(() => ({ on: true }));
vi.mock('@ui/hooks/useOrgKnowledge', () => ({ useOrgKnowledge: () => knowledge.on }));
import { createElement as h } from 'react';
import ContextDetailPage from './ContextDetailPage';
import { SharedViewContext } from '@ui/contexts/SharedViewContext';
import {
  renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent, within,
} from '@ui/test-utils/renderWithProviders';

// The two readers of one page (decided 2026-10-20): without
// data.write.contexts the business view, with it the analyst view. The unit
// here holds accounts, so its people come from the People overview
// (GET …/people), not from the members list.

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

const person = (over) => ({
  key: `principalId:${over.principalId}`, status: 'current', former: false, identityId: null, roles: [], role: null, rejoined: null, left: null,
  decision: null, stillListed: false, sources: ['list'], claims: [], contradictions: [], liveEntitlements: 0, linkedEntitlements: null, ...over,
});
const ALICE = person({ principalId: 'm-1', displayName: 'Alice Engineer', roles: ['Accountable'], role: { value: 'Staff engineer', status: 'confirmed' }, sources: ['list', 'interview'], liveEntitlements: 12 });
const DANA = person({ principalId: 'm-3', displayName: 'Dana Said', status: 'notConfirmed', sources: ['interview'], contradictions: ['memberNotListed:c-1'] });
const BOB = person({ principalId: 'm-2', displayName: 'Bob Builder', status: 'leftDecided', former: true, stillListed: true, liveEntitlements: 210,
  decision: { by: 'analyst@example.test', at: '2026-10-23T10:00:00Z', overrides: 'Demo EntraID', claimId: 'c-9' } });
const PEOPLE = { current: [ALICE, DANA], former: [BOB], all: [ALICE, DANA, BOB], decide: [DANA] };
const COUNTS = { current: 2, former: 1, all: 3, decide: 1 };

const CONTRADICTION = {
  id: 'memberNotListed:c-1', rule: 'memberNotListed', status: 'open', claimIds: ['c-1'],
  claim: { kind: 'claim', statement: 'Interview: Dana Said is a member', claim: { id: 'c-1', claimKind: 'membership', status: 'proposed', interviewId: 'iv-1', intervieweeName: 'Iris Interviewee', interviewedAt: '2026-10-01' } },
  other: { kind: 'fact', statement: 'Demo EntraID does not list Dana Said', source: 'Demo EntraID' },
};
const CLAIMS = { data: [
  { id: 'c-1', claimKind: 'membership', attribute: 'current', value: 'is in it', status: 'proposed', subjectName: 'Dana Said', interviewId: 'iv-1', intervieweeName: 'Iris Interviewee', interviewedAt: '2026-10-01' },
  { id: 'c-2', claimKind: 'property', attribute: 'sector', value: 'Health', status: 'proposed', interviewId: 'iv-1', intervieweeName: 'Iris Interviewee', interviewedAt: '2026-10-01' },
], contradictions: [CONTRADICTION], accountableDoubt: null };

// The People overview answers by filter; everything else by key, specific keys
// before the bare detail key (substring match).
function routes(overrides = {}) {
  const table = {
    '/api/contexts/ctx-1/members': { total: 0, data: [] },
    '/api/contexts/ctx-1/timeline': { events: [], sinceDays: 90 },
    '/api/contexts/ctx-1/relationships': [],
    '/api/contexts/ctx-1/roles/suggestion': jsonResponse(undefined, { status: 204 }),
    '/api/contexts/ctx-1/roles': [],
    '/api/contexts/ctx-1/claims': { data: [], contradictions: [], accountableDoubt: null },
    '/api/contexts/ctx-1/interviews': { data: [] },
    '/api/change-requests': { items: [] },
    '/api/contexts/ctx-parent': { attributes: { id: 'ctx-parent', displayName: 'Engineering Dept', parentContextId: 'ctx-root', parentDisplayName: 'Corp' } },
    '/api/contexts/ctx-root': { attributes: { id: 'ctx-root', displayName: 'Fortigi Demo Corp' } },
    '/api/contexts/ctx-1': { attributes: UNIT, subContexts: [{ id: 'ctx-child', displayName: 'Platform', memberCount: 3 }] },
    '/api/risk-scores/contexts/ctx-1': { riskScore: 50 },
    ...overrides,
  };
  return makeAuthFetch((url, opts) => {
    if (String(url).startsWith('/api/contexts/ctx-1/people')) {
      const filter = new URL(url, 'http://x').searchParams.get('filter');
      return { data: PEOPLE[filter], total: COUNTS[filter], counts: COUNTS, linkedResources: 0 };
    }
    if (opts?.method === 'DELETE') return jsonResponse(undefined, { status: 204 });
    const key = Object.keys(table).find(k => String(url).includes(k));
    return key ? table[key] : undefined;
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

const peopleReads = (authFetch, filter) => authFetch.mock.calls.filter(([u]) => String(u).startsWith(`/api/contexts/ctx-1/people?filter=${filter}`)).length;
async function openMenu(user) {
  await user.click(await screen.findByRole('button', { name: 'More actions' }));
  return screen.getByRole('menu', { name: 'More actions' });
}
const menuNames = (menu) => within(menu).getAllByRole('menuitem').map(i => i.textContent.replace(/(Could not|This tree).*$/, '').replace('…', ''));

describe('the business view (no data.write.contexts)', () => {
  it('shows the people, current and former, with Download report — no edits, review, sources or Timeline', async () => {
    const { authFetch, user } = mount({}, READER);
    const people = await screen.findByRole('region', { name: 'People' });
    expect(await within(people).findByText('Alice Engineer')).toBeInTheDocument();
    expect(screen.getByTestId('context-subtitle')).toHaveTextContent('Department · derived by the Department from Principal rule');
    expect(screen.getByRole('button', { name: 'Download report' })).toBeInTheDocument();
    for (const name of ['Add information', 'Edit members']) expect(screen.queryByRole('button', { name })).toBeNull();
    for (const region of ['Sources', 'Change requests', 'Timeline', 'Diff', 'Risk']) expect(screen.queryByRole('region', { name: region })).toBeNull();
    expect(screen.queryByTestId('attention-line')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    // The former people are the reader's too: who left but can still get in.
    await user.click(within(people).getByRole('button', { name: 'Former 1' }));
    expect(await within(people).findByText('Bob Builder')).toBeInTheDocument();
    expect(within(people).getAllByTestId('person-status').map(s => s.textContent)).toEqual(['Left (decided)', 'Left (decided)']);
    expect(authFetch).not.toHaveBeenCalledWith(expect.stringContaining('/timeline'));
    expect(authFetch).not.toHaveBeenCalledWith(expect.stringContaining('/interviews'));
    expect(authFetch).not.toHaveBeenCalledWith(expect.stringContaining('/api/change-requests'));
  });

  it('offers View in matrix and Copy link in the ⋯ menu, nothing to edit', async () => {
    const { user } = mount({}, READER);
    expect(menuNames(await openMenu(user))).toEqual(['View in matrix ↗', 'Copy link']);
  });

  it('keeps the unit facts folded in What we know: the description first, then the details a reader may see', async () => {
    const { user } = mount({}, { ...READER, authFetch: routes({ '/api/contexts/ctx-1': { attributes: { ...UNIT, description: 'The engineers of the demo company.' }, subContexts: [] } }) });
    const know = await screen.findByRole('region', { name: 'What we know' });
    expect(within(know).getByTestId('what-we-know-summary')).toHaveTextContent(/^The engineers of the demo company\.$/);
    await user.click(within(know).getByRole('button', { name: /What we know/ }));
    const details = within(know).getByRole('region', { name: 'More details' });
    expect([...details.querySelectorAll('dt')].map(d => d.textContent)).toEqual(['Last updated']);
  });

  it('a shared read-only view is a business view even with write permission: no menu at all, the report stays', async () => {
    mount({}, {}, (ui) => h(SharedViewContext.Provider, { value: true }, ui));
    expect(await screen.findByText('Alice Engineer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add information' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Download report' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Timeline' })).toBeNull();
    // Names are facts, not links, in a shell that may open no person's page.
    expect(screen.queryByRole('button', { name: 'Alice Engineer' })).toBeNull();
    // Not an owner's page: no references to expand, and no sub-unit or parent links.
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
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/#context:ctx-1$/));
    expect(await screen.findByText('Link copied')).toBeInTheDocument();
  });

  it('says so when the link cannot be copied', async () => {
    const { user } = mount({}, READER);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied'); }) }, configurable: true });
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Copy link' }));
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
  it('adds Add information and a menu with Adjust tree, Edit, Add sub-unit and Back to Contexts; Timeline, Diff and Risk at the foot', async () => {
    const { onClose, user } = mount();
    await screen.findByText('Alice Engineer');
    // In the header, and on the Sources line.
    expect(screen.getAllByRole('button', { name: 'Add information' })).toHaveLength(2);
    expect(menuNames(await openMenu(user))).toEqual(['View in matrix ↗', 'Adjust tree', 'Edit', 'Add sub-unit', 'Copy link', 'Back to Contexts']);
    await user.click(screen.getByRole('menuitem', { name: 'Back to Contexts' }));
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Timeline' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Diff' })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Risk' })).toBeInTheDocument();
  });

  it('while organisation knowledge is off it is a plain unit page: no Add information, no Sources, no Adjust tree', async () => {
    knowledge.on = false;
    try {
      const { user } = mount();
      await screen.findByText('Alice Engineer');
      expect(screen.queryByRole('button', { name: 'Add information' })).toBeNull();
      expect(screen.queryByRole('region', { name: 'Sources' })).toBeNull();
      expect(screen.queryByRole('region', { name: 'Change requests' })).toBeNull();
      expect(menuNames(await openMenu(user))).toEqual(['View in matrix ↗', 'Edit', 'Add sub-unit', 'Copy link', 'Back to Contexts']);
      expect(screen.getByRole('region', { name: 'People' })).toBeInTheDocument();
    } finally {
      knowledge.on = true;
    }
  });

  it('reads as one column: People, What we know, Sources, Sub-units, then the Timeline', async () => {
    mount();
    await screen.findByText('Alice Engineer');
    const order = ['People', 'What we know', 'Sources', 'Sub-units', 'Timeline'].map(name => screen.getByRole('region', { name }));
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING, `${i}`).toBeTruthy();
    }
    expect(screen.queryByRole('region', { name: 'Change requests' })).toBeNull();
  });

  it('on a unit created here "Edit members" adds the add box, and Remove on every row its list holds', async () => {
    const { user } = mount({}, { authFetch: manualUnit() });
    const people = await screen.findByRole('region', { name: 'People' });
    await within(people).findByText('Alice Engineer');
    expect(within(people).queryByRole('button', { name: 'Remove' })).toBeNull();

    await user.click(within(people).getByRole('button', { name: 'Edit members' }));
    expect(within(people).getByRole('textbox', { name: 'Search accounts to add' })).toBeInTheDocument();
    const row = (name) => within(people).getByText(name).closest('tr');
    expect(within(row('Alice Engineer')).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    // Only said by a source, not listed: nothing to remove.
    expect(within(row('Dana Said')).queryByRole('button', { name: 'Remove' })).toBeNull();

    await user.click(within(people).getByRole('button', { name: 'Done' }));
    expect(within(people).queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('Remove deletes the member and re-reads the people', async () => {
    const { authFetch, user } = mount({}, { authFetch: manualUnit() });
    const people = await screen.findByRole('region', { name: 'People' });
    await within(people).findByText('Alice Engineer');
    await user.click(within(people).getByRole('button', { name: 'Edit members' }));
    const before = peopleReads(authFetch, 'current');
    await user.click(within(within(people).getByText('Alice Engineer').closest('tr')).getByRole('button', { name: 'Remove' }));
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/ctx-1/members/m-1', expect.objectContaining({ method: 'DELETE' }));
    await waitFor(() => expect(peopleReads(authFetch, 'current')).toBeGreaterThan(before));
  });

  it('offers no member edit on a derived unit, where removed members would come back', async () => {
    const { user } = mount();
    await screen.findByText('Alice Engineer');
    expect(screen.queryByRole('button', { name: 'Edit members' })).toBeNull();
    // The unit itself still takes a new name or a sub-unit.
    await openMenu(user);
    expect(screen.getByRole('menuitem', { name: 'Add sub-unit' })).toBeInTheDocument();
  });

  it('offers no member edit, Edit or Add sub-unit on an imported unit', async () => {
    const { user } = mount({}, { authFetch: routes({ '/api/contexts/ctx-1': { attributes: { ...UNIT, variant: 'synced' }, subContexts: [] } }) });
    await screen.findByText('Alice Engineer');
    expect(screen.queryByRole('button', { name: 'Edit members' })).toBeNull();
    expect(menuNames(await openMenu(user))).toEqual(['View in matrix ↗', 'Adjust tree', 'Copy link', 'Back to Contexts']);
  });

  it('Add sub-unit asks a name and creates it under this unit', async () => {
    const authFetch = routes();
    const fetchWithPost = vi.fn(async (url, opts = {}) => (opts.method === 'POST'
      ? jsonResponse({ id: 'new', ...JSON.parse(opts.body) })
      : authFetch(url, opts)));
    const { user } = mount({}, { authFetch: fetchWithPost });
    await screen.findByText('Alice Engineer');
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Add sub-unit' }));
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
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Add sub-unit' }));
    let form = (await screen.findByText('Name of the new unit under Engineering')).closest('form');
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(refusing).not.toHaveBeenCalledWith('/api/contexts', expect.anything());

    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Add sub-unit' }));
    form = (await screen.findByText('Name of the new unit under Engineering')).closest('form');
    await user.type(within(form).getByRole('textbox'), 'Dup');
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('name taken')).toBeInTheDocument();
  });
});

describe('the attention line (analyst)', () => {
  const busy = () => routes({
    '/api/contexts/ctx-1/claims': CLAIMS,
    '/api/change-requests': { items: [{ id: 'cr-1', status: 'open', summary: 'Remove Bob Builder from Engineering', targetName: 'Demo EntraID', raisedAt: '2026-10-23T10:00:00Z' }] },
  });

  it('says what waits: to decide, to review, to correct in the source', async () => {
    mount({}, { authFetch: busy() });
    expect(await screen.findByTestId('attention-line')).toHaveTextContent('1 to decide·2 to review·1 to correct in the source');
  });

  it('"to decide" shows People filtered to the people with a contradiction', async () => {
    const { authFetch, user } = mount({}, { authFetch: busy() });
    const line = await screen.findByTestId('attention-line');
    await user.click(within(line).getByRole('button', { name: '1 to decide' }));
    const people = screen.getByRole('region', { name: 'People' });
    await waitFor(() => expect(within(people).getByRole('button', { name: 'To decide 1' })).toHaveAttribute('aria-pressed', 'true'));
    expect(peopleReads(authFetch, 'decide')).toBe(1);
  });

  it('"to review" opens the review drawer with every proposed claim; Escape closes it', async () => {
    const { user } = mount({}, { authFetch: busy() });
    const line = await screen.findByTestId('attention-line');
    await user.click(within(line).getByRole('button', { name: '2 to review' }));
    const drawer = screen.getByRole('dialog', { name: 'To review' });
    expect(within(drawer).getAllByTestId('claim-review-row')).toHaveLength(2);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'To review' })).toBeNull();
  });

  it('"to correct in the source" opens the change requests', async () => {
    const { user } = mount({}, { authFetch: busy() });
    const line = await screen.findByTestId('attention-line');
    const changes = screen.getByRole('region', { name: 'Change requests' });
    expect(within(changes).queryByText('Remove Bob Builder from Engineering')).toBeNull();
    await user.click(within(line).getByRole('button', { name: '1 to correct in the source' }));
    expect(within(changes).getByText('Remove Bob Builder from Engineering')).toBeInTheDocument();
  });

  it('"to decide" about the unit itself opens What we know instead', async () => {
    const unitOnly = { ...CONTRADICTION, id: 'property:c-2', rule: 'property', claimIds: ['c-2'],
      claim: { kind: 'claim', statement: 'Interview: sector is Health', claim: { ...CLAIMS.data[1] } } };
    const { authFetch, user } = mount({}, { authFetch: routes({ '/api/contexts/ctx-1/claims': { ...CLAIMS, contradictions: [unitOnly] } }) });
    const line = await screen.findByTestId('attention-line');
    await user.click(within(line).getByRole('button', { name: '1 to decide' }));
    const know = screen.getByRole('region', { name: 'What we know' });
    expect(within(know).getByRole('button', { name: /What we know/ })).toHaveAttribute('aria-expanded', 'true');
    expect(within(know).getByRole('region', { name: 'Contradictions' })).toHaveTextContent('Interview: sector is Health');
    expect(peopleReads(authFetch, 'decide')).toBe(0);
  });

  it('a reader never gets it', async () => {
    mount({}, { ...READER, authFetch: busy() });
    await screen.findByText('Alice Engineer');
    expect(screen.queryByTestId('attention-line')).toBeNull();
  });
});

describe('the members table (a context without a template)', () => {
  const generic = (members) => routes({
    '/api/contexts/ctx-1/members': members,
    '/api/contexts/ctx-1': { attributes: { ...UNIT, contextCategory: null }, subContexts: [] },
  });
  const MEMBERS = { total: 2, data: [
    { id: 'm-1', displayName: 'Alice Engineer', jobTitle: 'Staff Engineer', principalType: 'User', addedBy: 'algorithm' },
    { id: 'm-2', displayName: 'Bob Builder', jobTitle: 'Engineer', principalType: 'Guest', addedBy: 'analyst' },
  ] };

  it('hides a column empty for every row on the page, and shows account types in words', async () => {
    const { authFetch } = mount({}, { ...READER, authFetch: generic(MEMBERS) });
    const row = (await screen.findByText('Alice Engineer')).closest('tr');
    const headers = [...row.closest('table').querySelectorAll('th')].map(t => t.textContent);
    expect(headers).toEqual(['Name', 'Job title', 'Type']);
    expect([...row.cells].map(c => c.textContent)).toEqual(['Alice Engineer', 'Staff Engineer', 'Member']);
    expect(screen.getByText('Bob Builder').closest('tr')).toHaveTextContent('Guest');
    // No template: no People overview and no claims.
    expect(authFetch).not.toHaveBeenCalledWith(expect.stringContaining('/people'));
    expect(authFetch).not.toHaveBeenCalledWith(expect.stringContaining('/claims'));
  });

  it('keeps a column one row fills, leaving the other rows\' cells empty', async () => {
    mount({}, { ...READER, authFetch: generic({ total: 2, data: [{ id: 'a', displayName: 'A', email: 'a@x.com' }, { id: 'b', displayName: 'B' }] }) });
    const b = (await screen.findByText('B')).closest('tr');
    expect([...b.closest('table').querySelectorAll('th')].map(t => t.textContent)).toEqual(['Name', 'Email']);
    expect([...b.cells].map(c => c.textContent)).toEqual(['B', '']);
  });

  it('on a context created here, Remove deletes the member and re-reads the list; none with sub-units included', async () => {
    const authFetch = routes({
      '/api/contexts/ctx-1/members': MEMBERS,
      '/api/contexts/ctx-1': { attributes: { ...UNIT, contextCategory: null, variant: 'manual' }, subContexts: [] },
    });
    const { user } = mount({}, { authFetch });
    await screen.findByText('Bob Builder');
    await user.click(screen.getByRole('button', { name: 'Edit members' }));
    const reads = () => authFetch.mock.calls.filter(([u]) => String(u).startsWith('/api/contexts/ctx-1/members?')).length;
    const before = reads();
    await user.click(within(screen.getByText('Bob Builder').closest('tr')).getByRole('button', { name: 'Remove' }));
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/ctx-1/members/m-2', expect.objectContaining({ method: 'DELETE' }));
    await waitFor(() => expect(reads()).toBe(before + 1));
    await user.click(screen.getByLabelText('Include sub-units'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull());
  });
});
