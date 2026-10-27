// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import WorkbenchPage from './WorkbenchPage';
import { renderWithProviders, screen, within, waitFor, userEvent, jsonResponse, makeAuthFetch } from '@ui/test-utils/renderWithProviders';

const UNIT = 'u-1';
const claim = (id, status, extra = {}) => ({
  id, status, value: 'x', quote: 'they handle the claims', proposedBy: 'model', decidedBy: status === 'proposed' ? null : 'ann@x.test',
  contextName: 'Claims', source: { kind: 'interview', name: 'Marieke', fileName: 'i.txt', date: '2026-10-20' }, ...extra,
});
const knows = (kind, name, state, claims) => ({ kind, objectId: null, name, state, claims });
const person = (key, displayName, knowledge, extra = {}) => ({
  key, identityId: key.slice(2), principalId: null, displayName, email: null, jobTitle: 'Handler', direct: true, units: ['Claims'],
  accounts: [{ id: `acc-${key}`, displayName, systemName: 'Dir' }], knowledge, ...extra,
});

function payload() {
  return {
    unit: { id: UNIT, displayName: 'Claims Handling', contextType: 'Department', targetType: 'Identity' },
    scope: { includeChildren: true, units: 3, truncatedPeople: false, maxPeople: 400 },
    kinds: [],
    people: [
      person('i:a', 'Anna Vos', [knows('activity', 'Handle claims', 'confirmed', [claim('c1', 'confirmed')])], {
        accounts: [{ id: 'acc-a', displayName: 'Anna Vos', systemName: 'Dir' }, { id: 'acc-a2', displayName: 'adm-anna', systemName: 'AD' }],
      }),
      person('i:b', 'Bram Smit', [
        knows('activity', 'Handle claims', 'proposed', [claim('c2', 'proposed')]),
        knows('duty', 'Works council member', 'confirmed', [claim('c3', 'confirmed')]),
      ]),
      person('i:c', 'Cleo Kok', []),
    ],
    columns: [
      { id: 'r1', displayName: 'ClaimsSuite Read', resourceType: 'AppRole', systemName: 'CS', isRole: false, holders: 3, contains: [] },
      { id: 'br', displayName: 'Claims handler', resourceType: 'BusinessRole', systemName: 'CS', isRole: true, holders: 1, contains: ['r1', 'r2'] },
      { id: 'r2', displayName: 'Motor handler', resourceType: 'AppRole', systemName: 'CS', isRole: false, holders: 2, contains: [] },
      { id: 'or', displayName: 'WorksCouncil site', resourceType: 'Group', systemName: 'Dir', isRole: false, holders: 1, contains: [] },
    ],
    truncatedColumns: 0,
    cells: [
      { person: 'i:a', resourceId: 'r1', type: 'Direct', accounts: ['acc-a'], viaRoles: ['br'] },
      { person: 'i:a', resourceId: 'br', type: 'Direct', accounts: ['acc-a'], viaRoles: [] },
      { person: 'i:a', resourceId: 'r2', type: 'Indirect', accounts: ['acc-a2'], viaRoles: [] },
      { person: 'i:b', resourceId: 'r1', type: 'Direct', accounts: ['acc-b'], viaRoles: [] },
      { person: 'i:b', resourceId: 'or', type: 'Direct', accounts: ['acc-b'], viaRoles: [] },
      { person: 'i:c', resourceId: 'r1', type: 'Eligible', accounts: ['acc-c'], viaRoles: [] },
      { person: 'i:c', resourceId: 'r2', type: 'Direct', accounts: ['acc-c'], viaRoles: [] },
    ],
    generatedAt: '2026-10-27T09:00:00.000Z',
  };
}

function api({ fail = null } = {}) {
  const calls = [];
  const fetch = makeAuthFetch((url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : null });
    if (method !== 'GET') return fail ? jsonResponse({ error: fail }, { ok: false, status: 400 }) : { ok: true };
    if (url.startsWith(`/api/contexts/${UNIT}/workbench`)) return payload();
    return undefined;
  });
  return { fetch, calls };
}

function mount(opts = {}) {
  const user = userEvent.setup();
  const a = api(opts);
  const onCacheData = vi.fn();
  renderWithProviders(h(WorkbenchPage, { contextId: UNIT, onCacheData, onClose: () => {} }), { auth: { authFetch: a.fetch } });
  return { user, calls: a.calls, onCacheData };
}

const grid = () => screen.getByRole('table', { name: "Access of the unit's people" });
// The first render of the grid is the slow one on a loaded CI runner.
const opened = () => screen.findByRole('heading', { name: 'Claims Handling' }, { timeout: 5000 });
const candidate = () => screen.getByRole('complementary', { name: 'Candidate role' });
const shownCount = () => within(screen.getByRole('region', { name: 'Filters' })).getByText(/people shown/).textContent;
// Excel: open the column's filter, untick everything, tick these values, OK.
async function filterTo(user, column, labels) {
  await user.click(screen.getByRole('button', { name: `Filter ${column}` }));
  const menu = screen.getByRole('dialog', { name: `Filter ${column}` });
  await user.click(within(menu).getByRole('button', { name: 'None' }));
  for (const l of labels) await user.click(within(menu).getByRole('checkbox', { name: new RegExp(`^${l}`) }));
  await user.click(within(menu).getByRole('button', { name: 'OK' }));
}

describe('WorkbenchPage', () => {
  it('opens on the unit with one row per person in columns, the gaps counted, and labels the tab', async () => {
    const { onCacheData, calls } = mount();
    expect(await opened()).toBeInTheDocument();
    expect(calls[0].url).toBe(`/api/contexts/${UNIT}/workbench?includeChildren=true`);
    await waitFor(() => expect(onCacheData).toHaveBeenCalledWith(UNIT, 'workbench', { displayName: 'Workbench: Claims Handling' }));
    expect(screen.getByText(/3 people \(4 accounts\) across 3 units/)).toBeInTheDocument();
    expect(screen.getByText(/1 person has no known activity · 1 proposed link to check · 0 disputed/)).toBeInTheDocument();
    expect(within(grid()).getAllByRole('button', { name: /^Sort by / }).map(b => b.getAttribute('aria-label').slice(8))).toEqual(['Display name', 'Job title', 'Activity', 'Expertise', 'Duty']);
    expect(within(grid()).queryAllByRole('rowheader').filter(el => el.getAttribute('scope') === 'rowgroup')).toEqual([]);
    expect(shownCount()).toBe('3 of 3 people shown');
    expect(screen.getByText('2 accounts')).toBeInTheDocument();
  });

  it('filters like Excel — values with counts, (Not known), proposed in or out, AND across columns — without losing the candidate', async () => {
    const { user } = mount();
    await opened();
    await user.click(within(grid()).getByRole('button', { name: 'Anna Vos' }));
    await user.click(screen.getByRole('button', { name: 'Members only' }));
    await user.click(screen.getByRole('button', { name: 'Filter Activity' }));
    const menu = screen.getByRole('dialog', { name: 'Filter Activity' });
    expect(within(menu).getAllByRole('checkbox').map(b => b.closest('label').textContent)).toEqual(['Handle claims2', '(Not known)1', 'Count proposed (not yet confirmed) values']);
    await user.click(within(menu).getByRole('button', { name: 'Cancel' }));
    await filterTo(user, 'Activity', ['Handle claims']);
    expect(shownCount()).toBe('2 of 3 people shown');
    expect(screen.getByText('Activity: Handle claims')).toBeInTheDocument();
    // Proposed values out: Bram's activity is only proposed.
    await user.click(screen.getByRole('button', { name: 'Filter Activity' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Filter Activity' })).getByRole('checkbox', { name: /Count proposed/ }));
    await user.click(within(screen.getByRole('dialog', { name: 'Filter Activity' })).getByRole('button', { name: 'OK' }));
    expect(shownCount()).toBe('1 of 3 people shown');
    expect(screen.getByText('Activity: Handle claims (confirmed only)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear all filters' }));
    // AND across columns: Handle claims (proposed counts) and a duty.
    await filterTo(user, 'Activity', ['Handle claims']);
    await filterTo(user, 'Duty', ['Works council member']);
    expect(shownCount()).toBe('1 of 3 people shown');
    await filterTo(user, 'Duty', ['\\(Not known\\)']);
    expect(shownCount()).toBe('1 of 3 people shown');
    expect(within(grid()).getByRole('button', { name: 'Anna Vos' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Clear the filter Duty/ }));
    expect(shownCount()).toBe('2 of 3 people shown');
    expect(within(candidate()).getByText('Members (1)')).toBeInTheDocument();
    // The Excel move: take the people the filter leaves.
    await user.click(screen.getByRole('button', { name: 'Add the 2 shown as members' }));
    expect(within(candidate()).getByText('Members (2)')).toBeInTheDocument();
  });

  it('sorts by a column header, again the other way, a multi-value column by its strongest value', async () => {
    const { user } = mount();
    await opened();
    const names = () => ['Anna Vos', 'Bram Smit', 'Cleo Kok'].map(n => within(grid()).getByRole('button', { name: n }))
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)).map(b => b.textContent);
    await user.click(screen.getByRole('button', { name: 'Sort by Duty' }));
    expect(names()).toEqual(['Bram Smit', 'Anna Vos', 'Cleo Kok']);
    await user.click(screen.getByRole('button', { name: 'Sort by Display name' }));
    await user.click(screen.getByRole('button', { name: 'Sort by Display name' }));
    expect(names()).toEqual(['Cleo Kok', 'Bram Smit', 'Anna Vos']);
  });

  it('shows more columns from the chooser, and groups only when asked', async () => {
    const { user } = mount();
    await opened();
    await user.click(screen.getByRole('button', { name: 'Columns ▾' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Columns' })).getByRole('checkbox', { name: 'Accounts' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Columns' })).getByRole('checkbox', { name: 'Expertise' }));
    expect(within(grid()).getAllByRole('button', { name: /^Sort by / }).map(b => b.getAttribute('aria-label').slice(8))).toEqual(['Display name', 'Job title', 'Accounts', 'Activity', 'Duty']);
    await user.selectOptions(screen.getByLabelText('Group by'), 'duty');
    const rowgroups = within(grid()).getAllByRole('rowheader').filter(el => el.getAttribute('scope') === 'rowgroup');
    expect(rowgroups.map(r => r.textContent)).toEqual(['Works council member1 person', 'Not known2 people']);
  });

  it('shows the candidate as a Draft business role in the role band, colouring what it covers the matrix way', async () => {
    const { user } = mount();
    await opened();
    // The existing role is in the band on the right, not among the columns.
    expect(within(grid()).getByRole('columnheader', { name: 'Claims handler' })).toBeInTheDocument();
    await filterTo(user, 'Activity', ['Handle claims']);
    await user.click(screen.getByRole('button', { name: 'Select what they hold' }));
    expect(screen.getByText('4 cells · 2 people · 3 columns')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add to candidate' }));
    expect(within(candidate()).getByText('Members (2)')).toBeInTheDocument();
    expect(screen.getByText(/Click a cell, Shift-click for a rectangle/)).toBeInTheDocument();
    expect(within(candidate()).getByText('Entitlements (3)')).toBeInTheDocument();
    // No proposal by percentage: the panel only says how many members hold each; the analyst removes what does not belong.
    expect(within(candidate()).queryByRole('button', { name: 'Propose' })).toBeNull();
    expect(within(candidate()).queryByLabelText('Share of the members')).toBeNull();
    const entitlements = within(candidate()).getByText('Entitlements (3)').parentElement;
    expect(within(entitlements).getAllByText(/^\d\/2$/).map(e => e.textContent)).toEqual(['2/2', '1/2', '1/2']);
    await user.click(within(candidate()).getByRole('button', { name: 'Remove Motor handler' }));
    await user.click(within(candidate()).getByRole('button', { name: 'Remove WorksCouncil site' }));
    expect(within(candidate()).getByText('Entitlements (1)')).toBeInTheDocument();
    // Name it: the band says "Draft: <name>".
    await user.clear(within(candidate()).getByPlaceholderText('e.g. Claims handler — motor'));
    await user.type(within(candidate()).getByPlaceholderText('e.g. Claims handler — motor'), 'Motor v2');
    expect(within(grid()).getByRole('columnheader', { name: 'Draft: Motor v2' })).toBeInTheDocument();
    // Covered: the matrix's "managed by" cell in the draft's colour — Anna's read is covered by both roles.
    const covered = within(grid()).getAllByRole('button', { name: /Managed by: .*Draft: Motor v2/ });
    expect(covered).toHaveLength(2);
    expect(covered.find(b => /Claims handler, Draft/.test(b.getAttribute('aria-label')))).toBeTruthy();
    // The members' own cells in the Draft column are its provisioning gap: they would get it.
    expect(within(grid()).getAllByTitle(/Provisioning gap: business role expects Direct membership/)).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Clear all filters' }));
    // Cleo holds what the draft and the existing role hand out, without either: the matrix's held-outside marker.
    const cleoRow = within(grid()).getByRole('button', { name: 'Cleo Kok' }).closest('tr');
    const outside = within(cleoRow).getAllByRole('button', { name: /Held outside business-role governance/ });
    expect(outside.map(b => /Draft: Motor v2/.test(b.getAttribute('aria-label')))).toEqual([true, false]);
    expect(screen.queryByText(/loss/i)).not.toBeInTheDocument();
    expect(within(candidate()).getByText(/Already hold all of it, not members: Cleo Kok/)).toBeInTheDocument();
    await user.click(within(candidate()).getByRole('button', { name: 'Add them' }));
    expect(within(candidate()).getByText('Members (3)')).toBeInTheDocument();
  });

  it('marks a cell as other context on top of its matrix badge, and counts it in the impact', async () => {
    const { user } = mount();
    await opened();
    const bramRow = within(grid()).getByRole('button', { name: 'Bram Smit' }).closest('tr');
    const cellsInRow = within(bramRow).getAllByRole('button', { name: 'Direct' });
    await user.click(cellsInRow.at(-1));
    await user.click(screen.getByRole('button', { name: 'Mark: Other context' }));
    expect(within(bramRow).getByRole('button', { name: 'Other context — Direct' })).toHaveTextContent('DO');
    await user.click(within(bramRow).getByRole('button', { name: 'Bram Smit' }));
    await user.click(screen.getByRole('button', { name: 'Members only' }));
    expect(within(candidate()).getByText('Other context (marked)').nextSibling).toHaveTextContent('1');
  });
  it('keeps several proposed roles, each its own Draft column, opens one from its band header, and removes one after an in-page confirm', async () => {
    const { user } = mount();
    await opened();
    await user.click(within(grid()).getByRole('button', { name: 'Anna Vos' }));
    await user.click(screen.getByRole('button', { name: 'Add to candidate' }));
    await user.click(within(candidate()).getByRole('button', { name: 'New candidate role' }));
    await user.click(within(grid()).getByRole('button', { name: 'Cleo Kok' }));
    await user.click(screen.getByRole('button', { name: 'Add to candidate' }));
    const list = () => within(candidate()).getByRole('list', { name: 'Proposed roles' });
    expect(within(list()).getAllByRole('button').map(b => b.textContent)).toEqual(['Candidate 11 · 2', 'Candidate 21 · 2']);
    expect(within(grid()).getByRole('columnheader', { name: 'Draft: Candidate 1' })).toBeInTheDocument();
    expect(within(grid()).getByRole('columnheader', { name: 'Draft: Candidate 2' })).toBeInTheDocument();
    // The band header opens a proposed role in the panel.
    await user.click(within(grid()).getByText('Draft: Candidate 1'));
    expect(within(candidate()).getByDisplayValue('Candidate 1')).toBeInTheDocument();
    expect(within(list()).getByRole('button', { current: true })).toHaveTextContent('Candidate 1');
    // Remove it: the app's confirm, Cancel keeps it, Remove takes its column away.
    await user.click(within(candidate()).getByRole('button', { name: 'Remove this proposed role' }));
    expect(await screen.findByText('Remove proposed role')).toBeInTheDocument();
    expect(screen.getByText(/Remove the proposed role “Candidate 1”\? Its column and colours go/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(within(grid()).getByRole('columnheader', { name: 'Draft: Candidate 1' })).toBeInTheDocument();
    await user.click(within(candidate()).getByRole('button', { name: 'Remove this proposed role' }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(within(grid()).queryByRole('columnheader', { name: 'Draft: Candidate 1' })).toBeNull();
    expect(within(list()).getAllByRole('button').map(b => b.textContent)).toEqual(['Candidate 21 · 2']);
    expect(within(candidate()).getByDisplayValue('Candidate 2')).toBeInTheDocument();
  });

  it('opens an existing business role read-only from its band header, and proposes an update from it', async () => {
    const { user } = mount();
    await opened();
    await user.click(within(grid()).getByText('Claims handler'));
    const role = within(candidate()).getByRole('region', { name: 'Existing business role' });
    expect(within(role).getByText('Business role from the source · read-only here')).toBeInTheDocument();
    expect(within(role).getByText('Held here by (1)')).toBeInTheDocument();
    expect(within(role).getByText('Contains (2)')).toBeInTheDocument();
    expect(within(role).queryByRole('textbox')).toBeNull();
    await user.click(within(role).getByRole('button', { name: 'Propose update' }));
    expect(within(candidate()).getByRole('heading', { name: 'Proposed update to a role' })).toBeInTheDocument();
    expect(within(candidate()).getByDisplayValue('Claims handler')).toBeInTheDocument();
    expect(within(candidate()).getByText('Members (1)')).toBeInTheDocument();
    await user.click(within(candidate()).getByRole('button', { name: 'Remove Motor handler' }));
    expect(within(candidate()).getByText('Leaves out of the role: Motor handler')).toBeInTheDocument();
    expect(within(candidate()).getByText(/impact unknown/)).toBeInTheDocument();
    // The select starts one too.
    await user.selectOptions(within(candidate()).getByLabelText('Update an existing role'), 'br');
    expect(within(candidate()).getByRole('list', { name: 'Proposed roles' }).children).toHaveLength(2);
    await user.click(within(candidate()).getByRole('button', { name: /Reset everything/ }));
    expect(within(candidate()).getByText(/No proposed role yet/)).toBeInTheDocument();
  });
  it('shows a link’s evidence and confirms a proposed claim through the claims API', async () => {
    const { user, calls } = mount();
    await opened();
    const bramRow = within(grid()).getByRole('button', { name: 'Bram Smit' }).closest('tr');
    await user.click(within(bramRow).getByRole('button', { name: /Handle claims — proposed/ }));
    const dialog = screen.getByRole('dialog', { name: 'Evidence for Handle claims' });
    expect(within(dialog).getByText(/Proposed by the model · interview with Marieke, 2026-10-20 · about Claims/)).toBeInTheDocument();
    expect(within(dialog).getByText('“they handle the claims”')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(calls.some(c => c.method === 'PATCH')).toBe(true));
    expect(calls.find(c => c.method === 'PATCH')).toMatchObject({ url: '/api/contexts/claims/c2', body: { status: 'confirmed' } });
    await waitFor(() => expect(calls.filter(c => c.url.includes('/workbench')).length).toBe(2));
  });

  it('adds what a person does through the knowledge API, and shows the API’s refusal', async () => {
    const { user, calls } = mount();
    await opened();
    await user.click(within(grid()).getByRole('button', { name: 'Add expertise for Cleo Kok' }));
    const form = screen.getByRole('form', { name: 'Add for Cleo Kok' });
    await user.type(within(form).getByLabelText('Name'), 'Fraud detection');
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls.some(c => c.method === 'POST')).toBe(true));
    expect(calls.find(c => c.method === 'POST')).toMatchObject({
      url: `/api/contexts/${UNIT}/knowledge`, body: { kind: 'expertise', value: 'Fraud detection', identityId: 'c' },
    });
  });

  it('says why when an action fails', async () => {
    const { user } = mount({ fail: 'Choose who this claim is about' });
    await opened();
    const bramRow = within(grid()).getByRole('button', { name: 'Bram Smit' }).closest('tr');
    await user.click(within(bramRow).getByRole('button', { name: /Handle claims — proposed/ }));
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose who this claim is about');
  });

  it('selects a rectangle with Shift-click and adds one cell with Ctrl-click', async () => {
    const { user } = mount();
    await opened();
    const rows = ['Anna Vos', 'Bram Smit', 'Cleo Kok'].map(n => within(grid()).getByRole('button', { name: n }).closest('tr'));
    const cellsOf = (row) => within(row).getAllByRole('button').filter(b => b.getAttribute('aria-pressed') !== null);
    await user.click(cellsOf(rows[1])[0]);
    await user.keyboard('{Shift>}');
    await user.click(cellsOf(rows[2])[1]);
    await user.keyboard('{/Shift}');
    expect(screen.getByText('4 cells · 2 people · 2 columns')).toBeInTheDocument();
    await user.keyboard('{Control>}');
    await user.click(cellsOf(rows[0])[3]);
    await user.keyboard('{/Control}');
    expect(screen.getByText('5 cells · 3 people · 3 columns')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.getByText(/Click a cell, Shift-click for a rectangle/)).toBeInTheDocument();
  });

  it('filters the columns by holders and by name, and reads again without the sub-units', async () => {
    const { user, calls } = mount();
    await opened();
    const header = () => within(grid()).getAllByRole('button', { name: /^Select the column/ }).length;
    expect(header()).toBe(3);
    await user.tripleClick(screen.getByLabelText(/Access held by at least/));
    await user.keyboard('2');
    expect(header()).toBe(2);
    await user.type(screen.getByRole('searchbox', { name: 'Find a column' }), 'motor');
    expect(header()).toBe(1);
    await user.click(screen.getByLabelText('Include sub-units'));
    await waitFor(() => expect(calls.at(-1).url).toBe(`/api/contexts/${UNIT}/workbench?includeChildren=false`));
  });

  it('says how many members no longer resolve, instead of looking empty', async () => {
    const authFetch = makeAuthFetch(() => ({ ...payload(), people: [], cells: [], columns: [], scope: { ...payload().scope, unresolved: 10 } }));
    renderWithProviders(h(WorkbenchPage, { contextId: UNIT }), { auth: { authFetch } });
    expect(await screen.findByRole('status')).toHaveTextContent('10 members are no longer in their source (a later sync removed them) and are left out.');
  });

  it('shows the API error with a way to try again', async () => {
    const user = userEvent.setup();
    const authFetch = makeAuthFetch(() => jsonResponse({ error: 'The authorization workbench opens on an organizational unit.' }, { ok: false, status: 400 }));
    renderWithProviders(h(WorkbenchPage, { contextId: UNIT }), { auth: { authFetch } });
    expect(await screen.findByText('The authorization workbench opens on an organizational unit.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
  });
});
