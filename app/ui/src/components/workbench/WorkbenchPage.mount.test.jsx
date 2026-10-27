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

describe('WorkbenchPage', () => {
  it('opens on the unit with its people grouped by activity, the gaps counted, and labels the tab', async () => {
    const { onCacheData, calls } = mount();
    expect(await opened()).toBeInTheDocument();
    expect(calls[0].url).toBe(`/api/contexts/${UNIT}/workbench?includeChildren=true`);
    expect(onCacheData).toHaveBeenCalledWith(UNIT, 'workbench', { displayName: 'Workbench: Claims Handling' });
    expect(screen.getByText(/3 people \(4 accounts\) across 3 units/)).toBeInTheDocument();
    expect(screen.getByText(/1 person has no known activity · 1 proposed link to check · 0 disputed/)).toBeInTheDocument();
    const rowgroups = within(grid()).getAllByRole('rowheader').filter(el => el.getAttribute('scope') === 'rowgroup');
    expect(rowgroups.map(r => r.textContent)).toEqual(['Handle claims2 people', 'Not known1 person']);
    expect(screen.getByText('2 accounts')).toBeInTheDocument();
  });

  it('regroups by duty without losing the candidate', async () => {
    const { user } = mount();
    await opened();
    await user.click(within(grid()).getByRole('button', { name: 'Anna Vos' }));
    await user.click(screen.getByRole('button', { name: 'Members only' }));
    expect(within(candidate()).getByText('Members (1)')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Duty' }));
    expect(within(grid()).getByRole('button', { name: 'Works council member' })).toBeInTheDocument();
    expect(within(candidate()).getByText('Members (1)')).toBeInTheDocument();
  });

  it('adds a group’s held cells to the candidate and shows the impact with words, never a loss', async () => {
    const { user } = mount();
    await opened();
    await user.click(within(grid()).getByRole('button', { name: 'Handle claims' }));
    expect(screen.getByText('5 cells · 2 people · 4 columns')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add to candidate' }));
    expect(within(candidate()).getByText('Members (2)')).toBeInTheDocument();
    expect(within(candidate()).getByText('Entitlements (4)')).toBeInTheDocument();
    // Keep only what both members hold.
    await user.selectOptions(within(candidate()).getByLabelText('Share of the members'), '1');
    await user.click(within(candidate()).getByRole('button', { name: 'Propose' }));
    expect(within(candidate()).getByText('Entitlements (1)')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Show candidate impact'));
    const covered = within(grid()).getAllByRole('button', { name: /^Covered/ });
    expect(covered).toHaveLength(2);
    expect(within(grid()).getAllByRole('button', { name: /^Outside the candidate/ })).toHaveLength(3);
    expect(screen.queryByText(/loss/i)).not.toBeInTheDocument();
    // Cleo holds the one entitlement and is not a member.
    expect(within(candidate()).getByText(/Already hold all of it, not members: Cleo Kok/)).toBeInTheDocument();
    await user.click(within(candidate()).getByRole('button', { name: 'Add them' }));
    expect(within(candidate()).getByText('Members (3)')).toBeInTheDocument();
  });

  it('marks a cell as other context, and the impact says so instead of outside', async () => {
    const { user } = mount();
    await opened();
    const orCell = within(grid()).getAllByRole('button', { name: 'Direct' }).find(b => b.closest('tr').textContent.includes('Bram'));
    // Bram's cells: r1 then 'or' — pick the last Direct one in his row.
    const bramRow = orCell.closest('tr');
    const cellsInRow = within(bramRow).getAllByRole('button', { name: 'Direct' });
    await user.click(cellsInRow.at(-1));
    await user.click(screen.getByRole('button', { name: 'Mark: Other context' }));
    expect(within(bramRow).getByRole('button', { name: /marked: Other context/ })).toHaveTextContent('O');
    await user.click(within(bramRow).getByRole('button', { name: 'Bram Smit' }));
    await user.click(screen.getByRole('button', { name: 'Members only' }));
    await user.click(screen.getByLabelText('Show candidate impact'));
    expect(within(candidate()).getByText('Other context (marked)').nextSibling).toHaveTextContent('1');
  });

  it('starts an update from an existing business role and shows how it differs from the role', async () => {
    const { user } = mount();
    await opened();
    await user.selectOptions(within(candidate()).getByLabelText('Start from'), 'br');
    expect(within(candidate()).getByRole('heading', { name: 'Proposed update to a role' })).toBeInTheDocument();
    expect(within(candidate()).getByDisplayValue('Claims handler')).toBeInTheDocument();
    expect(within(candidate()).getByText('Members (1)')).toBeInTheDocument();
    await user.click(within(candidate()).getByRole('button', { name: 'Remove Motor handler' }));
    expect(within(candidate()).getByText('Leaves out of the role: Motor handler')).toBeInTheDocument();
    expect(within(candidate()).getByText(/impact unknown/)).toBeInTheDocument();
    await user.click(within(candidate()).getByRole('button', { name: /Reset the draft/ }));
    expect(within(candidate()).getByRole('heading', { name: 'Candidate role' })).toBeInTheDocument();
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
    await user.click(within(grid()).getByRole('button', { name: 'Add what Cleo Kok does, knows or holds' }));
    const form = screen.getByRole('form', { name: 'Add for Cleo Kok' });
    await user.selectOptions(within(form).getByLabelText('Kind'), 'expertise');
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
    await user.click(screen.getByRole('radio', { name: 'No grouping' }));
    const rows = within(grid()).getAllByRole('row').filter(r => within(r).queryAllByRole('rowheader').some(x => x.getAttribute('scope') === 'row'));
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
    expect(header()).toBe(4);
    await user.tripleClick(screen.getByLabelText(/Columns held by at least/));
    await user.keyboard('2');
    expect(header()).toBe(2);
    await user.type(screen.getByRole('searchbox', { name: 'Find a column' }), 'motor');
    expect(header()).toBe(1);
    await user.click(screen.getByLabelText('Include sub-units'));
    await waitFor(() => expect(calls.at(-1).url).toBe(`/api/contexts/${UNIT}/workbench?includeChildren=false`));
  });

  it('shows the API error with a way to try again', async () => {
    const user = userEvent.setup();
    const authFetch = makeAuthFetch(() => jsonResponse({ error: 'The authorization workbench opens on an organizational unit.' }, { ok: false, status: 400 }));
    renderWithProviders(h(WorkbenchPage, { contextId: UNIT }), { auth: { authFetch } });
    expect(await screen.findByText('The authorization workbench opens on an organizational unit.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
  });
});
