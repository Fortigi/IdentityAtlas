// @vitest-environment jsdom
// The Activity section of a context page: the four groups of one unit, the
// sub-unit × month table of a root, the period selector, the history with Undo
// (analysts only), and when the section is not there at all.
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import ActivitySection from './ActivitySection';
import { notifyActivityChanged } from './activityEvents';
import { SharedViewContext } from '@ui/contexts/SharedViewContext';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, within, waitFor, act } from '@ui/test-utils/renderWithProviders';

const UNIT = { id: 'unit-1', displayName: 'Northwind Traders', contextCategory: 'OrganizationalUnit', targetType: 'Identity' };
const MONTHS = ['2026-03', '2026-04'];
const person = (over) => ({
  displayName: 'Vera Example', identityId: 'I-vera', principalId: 'P-vera', subjectEmail: 'vera@example.org', amount: 3.5,
  amounts: { hours: 3.5 }, rows: 3, firstDate: '2026-03-02', lastDate: '2026-04-20',
  perMonth: [{ month: '2026-03', amount: 2 }, { month: '2026-04', amount: 1.5 }], ...over,
});
const OWN = {
  contextId: 'unit-1', period: { from: '2025-05-01', to: '2026-04-20' }, months: MONTHS, unit: 'hours', comparable: true,
  groups: [
    { key: 'memberAndActive', people: [person()] },
    { key: 'activeNotMember', people: [person({ displayName: 'Tom Sample', identityId: null, principalId: 'P-tom', subjectEmail: null, amount: 6 })] },
    { key: 'memberNoActivity', people: [{ displayName: 'Kim Idle', memberId: 'I-kim', memberType: 'Identity', email: null }] },
    { key: 'activeUnknown', people: [person({ displayName: 'Ghost Person', identityId: null, principalId: null, subjectEmail: null, amount: 0.5 })] },
  ],
};
const SUMMARY = {
  period: { from: '2025-05-01', to: '2026-04-20' }, months: MONTHS, unit: 'hours', comparable: true,
  children: [
    { contextId: 'c-north', displayName: 'Northwind Traders', total: 7.5, activePeople: 2, activeNotMember: 1, activeUnknown: 0, memberNoActivity: 1, perMonth: [{ month: '2026-03', amount: 2 }, { month: '2026-04', amount: 5.5 }] },
    { contextId: 'c-quiet', displayName: 'Quiet Co', total: 0, activePeople: 0, activeNotMember: 0, activeUnknown: 0, memberNoActivity: 0, perMonth: [{ month: '2026-03', amount: 0 }, { month: '2026-04', amount: 0 }] },
  ],
  totals: { total: 7.5, perMonth: [{ month: '2026-03', amount: 2 }, { month: '2026-04', amount: 5.5 }] },
};
const UPLOADS = [
  { id: 'u-2', contextId: 'unit-1', contextName: 'Northwind Traders', fileName: 'apr.csv', sourceLabel: 'Clockify', periodStart: '2026-04-01', periodEnd: '2026-04-20', rowsHeld: 12, uploadedAt: '2026-04-21T10:00:00Z', uploadedBy: 'analyst@example.org' },
  { id: 'u-1', contextId: 'root-1', contextName: 'Customers', fileName: 'q1.csv', sourceLabel: 'Clockify', periodStart: '2026-01-01', periodEnd: '2026-03-31', rowsHeld: 0, uploadedAt: '2026-04-01T10:00:00Z' },
];
const EMPTY = { period: null, months: [], groups: [] };

function api(overrides = {}) {
  return makeAuthFetch((url, opts) => {
    const u = String(url);
    if (opts?.method === 'DELETE') return overrides.delete ?? { uploadId: 'u-2', rowsRemoved: 12 };
    if (u.includes('/activity/uploads')) return { data: overrides.uploads ?? UPLOADS };
    if (u.includes('/activity/summary')) return overrides.summary ?? SUMMARY;
    if (u.includes('/activity')) return overrides.own ?? OWN;
    return undefined;
  });
}

function mount({ attrs = UNIT, subContexts = [], authFetch = api(), auth = {}, sharedView = false } = {}) {
  const onOpenDetail = vi.fn();
  const section = h(ActivitySection, { attrs, subContexts, onOpenDetail });
  renderWithProviders(h(SharedViewContext.Provider, { value: sharedView }, section), { auth: { authFetch, ...auth } });
  return { authFetch, onOpenDetail, user: userEvent.setup() };
}

const group = (key) => screen.getByTestId(`activity-group-${key}`);
// The GET reads that went out for a path (an undo's DELETE is not a read).
const called = (authFetch, part) => authFetch.mock.calls.filter(([, o]) => !o?.method).map(([u]) => String(u)).filter(u => u.includes(part));

describe('ActivitySection — one unit', () => {
  it('shows the four groups with each person\'s hours, dates and a bar per month', async () => {
    mount();
    expect(await screen.findByRole('region', { name: 'Activity' })).toBeInTheDocument();
    const active = group('memberAndActive');
    expect(within(active).getByRole('heading')).toHaveTextContent('Member and active (1)');
    expect(within(active).getByText('3.5 h')).toBeInTheDocument();
    expect(within(active).getByText('2026-03-02 – 2026-04-20')).toBeInTheDocument();
    expect(within(active).getByRole('img', { name: 'Per month: Mar 2026 2 h, Apr 2026 1.5 h' })).toBeInTheDocument();
    expect(within(group('activeNotMember')).getByText('suggestion')).toBeInTheDocument();
    expect(within(group('activeNotMember')).getByText('6 h')).toBeInTheDocument();
    // A member without activity has no hours, dates or bars.
    expect(within(group('memberNoActivity')).getByText('Kim Idle')).toBeInTheDocument();
    expect(within(group('memberNoActivity')).queryByRole('img')).toBeNull();
    expect(within(group('activeUnknown')).getByText('Ghost Person')).toBeInTheDocument();
    expect(screen.queryByTestId('activity-children')).toBeNull();
  });

  it('a known person opens their page; an unknown one is plain text', async () => {
    const { user, onOpenDetail } = mount();
    await user.click(await within(await screen.findByTestId('activity-group-activeNotMember')).findByRole('button', { name: 'Tom Sample' }));
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'P-tom', 'Tom Sample');
    await user.click(within(group('memberNoActivity')).getByRole('button', { name: 'Kim Idle' }));
    expect(onOpenDetail).toHaveBeenLastCalledWith('identity', 'I-kim', 'Kim Idle');
    expect(within(group('activeUnknown')).queryByRole('button')).toBeNull();
  });

  it('a chosen period is asked for, counted back from the latest activity', async () => {
    const { user, authFetch } = mount();
    await screen.findByRole('region', { name: 'Activity' });
    expect(called(authFetch, '/activity?')).toEqual([]);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Period' }), '3');
    await waitFor(() => expect(called(authFetch, '/activity?')).toEqual(['/api/contexts/unit-1/activity?from=2026-02-01&to=2026-04-20']));
  });

  it('is not there without any activity or upload', async () => {
    const { authFetch } = mount({ authFetch: api({ own: EMPTY, uploads: [] }) });
    await waitFor(() => expect(called(authFetch, '/activity/uploads')).toHaveLength(1));
    expect(screen.queryByRole('region', { name: 'Activity' })).toBeNull();
    // A unit without sub-units does not ask for the table.
    expect(called(authFetch, '/activity/summary')).toEqual([]);
  });

  it('is not there in a read-only shared view (a context owner cannot read activity)', () => {
    const { authFetch } = mount({ sharedView: true });
    expect(screen.queryByRole('region', { name: 'Activity' })).toBeNull();
    expect(authFetch).not.toHaveBeenCalled();
  });
});

describe('ActivitySection — a root', () => {
  it('shows its sub-units by month with the suggestion counts and totals; a sub-unit opens', async () => {
    const { user, onOpenDetail } = mount({ attrs: { ...UNIT, id: 'root-1', displayName: 'Customers' }, subContexts: [{ id: 'c-north' }], authFetch: api({ own: EMPTY }) });
    const table = await screen.findByTestId('activity-children');
    expect(screen.queryByTestId('activity-groups')).toBeNull();
    const rows = within(table).getAllByRole('row');
    expect(rows.map(r => r.textContent)).toEqual([
      'Sub-unitTotalActive peopleActive, not a memberMember, no activityMarApr',
      'Northwind Traders7.5 h21125.5',
      'Quiet Co0 h000',
      'Total7.5 h25.5',
    ]);
    await user.click(within(table).getByRole('button', { name: 'Northwind Traders' }));
    expect(onOpenDetail).toHaveBeenCalledWith('context', 'c-north', 'Northwind Traders');
  });

  it('a tree of resources has no suggestion columns', async () => {
    mount({ subContexts: [{ id: 'c' }], authFetch: api({ own: EMPTY, summary: { ...SUMMARY, comparable: false } }) });
    const table = await screen.findByTestId('activity-children');
    expect(within(table).queryByText('Active, not a member')).toBeNull();
  });
});

describe('ActivitySection — the history', () => {
  it('an analyst can undo an upload made here (not one made on the root); the section re-reads', async () => {
    const { user, authFetch } = mount();
    const history = await screen.findByTestId('activity-uploads');
    await user.click(within(history).getByText('Uploads (2)'));
    expect(within(history).getByText(/Clockify · q1\.csv · 2026-01-01 – 2026-03-31 · replaced by a later upload/)).toBeInTheDocument();
    expect(within(history).getByText(/uploaded on Customers/)).toBeInTheDocument();
    expect(within(history).getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
    const reads = called(authFetch, '/activity/uploads').length;
    await user.click(within(history).getByRole('button', { name: 'Undo' }));
    await user.click(await screen.findByRole('button', { name: 'Undo upload' }));
    await waitFor(() => expect(authFetch.mock.calls.some(([u, o]) => o?.method === 'DELETE' && String(u) === '/api/contexts/unit-1/activity/uploads/u-2')).toBe(true));
    await waitFor(() => expect(called(authFetch, '/activity/uploads').length).toBe(reads + 1));
  });

  it('a business reader sees the history read-only', async () => {
    mount({ auth: { hasWildcard: false, permissions: new Set(['data.read']) } });
    const history = await screen.findByTestId('activity-uploads');
    expect(within(history).queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('an import elsewhere on the page makes it read again', async () => {
    const { authFetch } = mount();
    await screen.findByRole('region', { name: 'Activity' });
    const before = called(authFetch, '/activity').length;
    act(() => notifyActivityChanged('unit-1'));
    await waitFor(() => expect(called(authFetch, '/activity').length).toBeGreaterThan(before));
    // Another context's change is not this one's.
    const after = called(authFetch, '/activity').length;
    act(() => notifyActivityChanged('someone-else'));
    expect(called(authFetch, '/activity').length).toBe(after);
  });

  it('a failed undo says why', async () => {
    const { user } = mount({ authFetch: api({ delete: jsonResponse({ error: 'No such upload on this context.' }, { ok: false, status: 404 }) }) });
    const history = await screen.findByTestId('activity-uploads');
    await user.click(within(history).getByText('Uploads (2)'));
    await user.click(within(history).getByRole('button', { name: 'Undo' }));
    await user.click(await screen.findByRole('button', { name: 'Undo upload' }));
    expect(await screen.findByText('No such upload on this context.')).toBeInTheDocument();
  });
});
