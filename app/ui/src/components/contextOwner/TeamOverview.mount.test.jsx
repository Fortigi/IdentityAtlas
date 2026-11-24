// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import UnitTeamPeople from './UnitTeamPeople';
import TeamOverview from './TeamOverview';
import {
  changeSentence, changeTone, groupChanges, nameSeparator, ungovernedLabel,
  roleMarkLabel, groupUngoverned,
} from './teamOverview.helpers';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, within } from '@ui/test-utils/renderWithProviders';

const ANN = { id: 'a', kind: 'user', displayName: 'Ann Vos', permissions: 9, ungoverned: 4, accessible: true };
const BOB = { id: 'b', kind: 'user', displayName: 'Bob Kok', permissions: 3, ungoverned: 0, accessible: true };
const OVERVIEW = {
  sinceDays: 30, totalPeople: 2, truncated: false, people: [ANN, BOB],
  roles: [
    {
      id: 'r1', displayName: 'Finance Analyst', holders: ['a'], origins: { a: { origin: 'Automatic', originDetail: 'AutoAssign: Finance' } },
      accessModel: { waysIn: ['Rule'], waysOut: ['Rule'], control: 'Automatic', reviewGap: false },
      review: { complianceStatus: null, hasReviewConfigured: false },
    },
    {
      id: 'r2', displayName: 'Payments Approver', holders: ['a', 'b'], origins: { a: { origin: 'Requested', originDetail: 'Request & Approval' }, b: { origin: null, originDetail: null } },
      accessModel: { waysIn: ['Request'], waysOut: [], control: 'Manual', reviewGap: true },
      review: { complianceStatus: 'Missed', daysOverdue: 12, reviewDeadline: '2026-11-12' },
    },
  ],
  changes: [
    { at: '2026-11-05T10:00:00Z', type: 'role-added', personKind: 'user', personId: 'a', personName: 'Ann Vos', roleName: 'Finance Analyst', accessible: true },
    { at: '2026-11-04T10:00:00Z', type: 'left', personKind: 'user', personId: 'c', personName: 'Cas Former', accessible: false },
  ],
};

describe('team overview words', () => {
  it.each([
    ['joined', ' joined the team', 'added'],
    ['left', ' left the team', 'removed'],
    ['role-added', ' received R', 'added'],
    ['role-removed', ' no longer has R', 'removed'],
  ])('%s', (type, after, tone) => {
    expect(changeSentence({ type, roleName: 'R' })).toBe(after);
    expect(changeTone({ type })).toBe(tone);
  });

  it('says "have" for several people losing a role', () => {
    expect(changeSentence({ type: 'role-removed', roleName: 'R' }, 2)).toBe(' no longer have R');
  });

  it('an unknown change says nothing rather than crashing', () => {
    expect(changeSentence({ type: 'other' })).toBe('');
  });

  it('names how the source says someone got a role, when it says', () => {
    expect(roleMarkLabel('A', 'R', { originDetail: 'Rule 1' })).toBe('A holds R (Rule 1)');
    expect(roleMarkLabel('A', 'R', { originDetail: null })).toBe('A holds R');
    expect(roleMarkLabel('A', 'R')).toBe('A holds R');
  });

  it('groups permissions in a fixed order and keeps the unknown kinds', () => {
    const items = [
      { id: '1', resourceType: 'SomethingNew' }, { id: '2', resourceType: 'GroupOwnership' }, { id: '3', resourceType: 'ApplicationOwnership' },
      { id: '4', resourceType: 'AppRole' }, { id: '5', resourceType: 'Group' },
    ];
    expect(groupUngoverned(items).map(s => [s.label, s.items.map(i => i.id)])).toEqual([
      ['Groups', ['5']], ['Application roles', ['4']], ['Owner of', ['2', '3']], ['Other access', ['1']],
    ]);
    expect(groupUngoverned([])).toEqual([]);
  });

  it('counts the permissions in the singular and the plural', () => {
    expect(ungovernedLabel({ displayName: 'A', ungoverned: 1, permissions: 1 })).toBe('A: 1 of 1 permission not covered by a business role');
    expect(ungovernedLabel({ displayName: 'A', ungoverned: 1, permissions: 2 })).toBe('A: 1 of 2 permissions not covered by a business role');
  });

  it.each([[0, 1, ''], [0, 2, ' and '], [1, 2, ''], [0, 3, ', '], [1, 3, ' and '], [2, 3, '']])('separator at %i of %i', (i, total, out) => {
    expect(nameSeparator(i, total)).toBe(out);
  });

  it('groups the same change on one day, and keeps other days, roles and types apart', () => {
    const c = (at, type, personId, roleName) => ({ at, type, personId, personKind: 'user', personName: personId, roleName });
    const groups = groupChanges([
      c('2026-11-05T10:00:00Z', 'role-added', 'a', 'R'),
      c('2026-11-05T11:00:00Z', 'role-added', 'b', 'R'),
      c('2026-11-05T11:00:00Z', 'role-added', 'b', 'R'),
      c('2026-11-05T10:00:00Z', 'role-added', 'a', 'S'),
      c('2026-11-05T10:00:00Z', 'role-removed', 'a', 'R'),
      c('2026-11-04T10:00:00Z', 'role-added', 'c', 'R'),
    ]);
    expect(groups.map(g => [g.type, g.roleName, g.people.map(p => p.id)])).toEqual([
      ['role-added', 'R', ['a', 'b']],
      ['role-added', 'S', ['a']],
      ['role-removed', 'R', ['a']],
      ['role-added', 'R', ['c']],
    ]);
  });
});

describe('TeamOverview', () => {
  it('marks exactly who holds a role and shows each person\'s ungoverned count', () => {
    renderWithProviders(<TeamOverview overview={OVERVIEW} onOpenDetail={vi.fn()} />);
    expect(screen.getByRole('img', { name: 'Ann Vos holds Finance Analyst (AutoAssign: Finance)' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /^Bob Kok holds Finance Analyst/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Ann Vos: 4 of 9 permissions/ })).toHaveTextContent('4');
    expect(screen.getByLabelText('Bob Kok: 0 of 3 permissions not covered by a business role')).toHaveTextContent('0');
    expect(screen.queryByRole('button', { name: /^Bob Kok: 0 of 3/ })).toBeNull();
  });

  it('opens a business role\'s own page, and names one the reader may not open without a link', async () => {
    const open = vi.fn();
    const overview = { ...OVERVIEW, roles: [OVERVIEW.roles[0], { ...OVERVIEW.roles[1], accessible: false }] };
    renderWithProviders(<TeamOverview overview={overview} onOpenDetail={open} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Finance Analyst' }));
    expect(open).toHaveBeenCalledWith('access-package', 'r1', 'Finance Analyst');
    expect(screen.queryByRole('button', { name: /Payments Approver/ })).toBeNull();
    expect(screen.getByRole('rowheader', { name: /Payments Approver/ })).toBeInTheDocument();
  });

  it('gives each role its type and review once, as on the Business Roles list', () => {
    renderWithProviders(<TeamOverview overview={OVERVIEW} onOpenDetail={vi.fn()} />);
    expect(screen.getByRole('columnheader', { name: 'Type' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Review status' })).toBeInTheDocument();
    const [finance, payments] = ['Finance Analyst', 'Payments Approver'].map(n => screen.getByRole('rowheader', { name: n }).closest('tr'));
    expect(within(finance).getByTestId('role-type')).toHaveTextContent('Rule based');
    expect(within(finance).getByText('Not required')).toBeInTheDocument();
    expect(within(payments).getByTestId('role-type')).toHaveTextContent('Manual');
    expect(within(payments).getByText('no review set up')).toBeInTheDocument();
    expect(within(payments).getByText(/Missed/)).toHaveTextContent('Missed (12d ago)');
  });

  it('marks a holder with a blue tick, the same for everyone who holds the role', () => {
    renderWithProviders(<TeamOverview overview={OVERVIEW} onOpenDetail={vi.fn()} />);
    const ticks = [
      screen.getByRole('img', { name: 'Ann Vos holds Payments Approver (Request & Approval)' }),
      screen.getByRole('img', { name: 'Bob Kok holds Payments Approver' }),
    ];
    for (const tick of ticks) {
      expect(tick).toHaveClass('bg-blue-100');
      expect(tick.textContent).toBe('');
    }
    expect(screen.queryByRole('list', { name: 'How a role is assigned' })).toBeNull();
  });

  it('heads each person\'s column with their name read bottom to top', () => {
    renderWithProviders(<TeamOverview overview={OVERVIEW} onOpenDetail={vi.fn()} />);
    const heading = screen.getByRole('columnheader', { name: 'Ann Vos' });
    expect(within(heading).getByTitle('Ann Vos')).toHaveClass('[writing-mode:vertical-rl]', 'rotate-180');
  });

  it('opens one person\'s ungoverned permissions, grouped, searchable and linked', async () => {
    const authFetch = makeAuthFetch({ '/api/contexts/ctx-1/team-overview/a/ungoverned': {
      truncated: false,
      items: [
        { id: 'g1', displayName: 'FS-Finance', resourceType: 'Group', how: 'Direct', accessible: true },
        { id: 'x1', displayName: 'Admin on Datadog', resourceType: 'AppRole', how: 'Indirect', accessible: true },
      ],
    } });
    const open = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<TeamOverview contextId="ctx-1" overview={OVERVIEW} onOpenDetail={open} />, { auth: { authFetch } });
    await user.click(screen.getByRole('button', { name: /^Ann Vos: 4 of 9/ }));
    const apps = await screen.findByRole('region', { name: 'Application roles' });
    expect(within(apps).getByText('Inherited')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Groups' })).queryByText('Inherited')).toBeNull();

    await user.type(screen.getByRole('searchbox', { name: 'Search these permissions' }), 'datadog');
    expect(screen.queryByText('FS-Finance')).toBeNull();
    await user.clear(screen.getByRole('searchbox', { name: 'Search these permissions' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search these permissions' }), 'nothing');
    expect(screen.getByText('Nothing matches this search.')).toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox', { name: 'Search these permissions' }));

    await user.click(screen.getByRole('button', { name: 'FS-Finance' }));
    expect(open).toHaveBeenCalledWith('resource', 'g1', 'FS-Finance');
    expect(screen.queryByRole('searchbox', { name: 'Search these permissions' })).toBeNull();
  });

  it('says so when the list fails, or was cut', async () => {
    const user = userEvent.setup();
    const failing = makeAuthFetch(() => jsonResponse({ error: 'no' }, { ok: false, status: 500 }));
    const { unmount } = renderWithProviders(<TeamOverview contextId="ctx-1" overview={OVERVIEW} />, { auth: { authFetch: failing } });
    await user.click(screen.getByRole('button', { name: /^Ann Vos: 4 of 9/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alert')).toBeNull();
    unmount();

    const cut = makeAuthFetch({ '/ungoverned': { truncated: true, items: [{ id: 'g1', displayName: 'FS-Finance', resourceType: 'Group', how: 'Direct' }] } });
    renderWithProviders(<TeamOverview contextId="ctx-1" overview={OVERVIEW} />, { auth: { authFetch: cut } });
    await user.click(screen.getByRole('button', { name: /^Ann Vos: 4 of 9/ }));
    expect(await screen.findByText('Showing the first 1.')).toBeInTheDocument();
  });

  it('opens a current member, and names someone who left without a link', async () => {
    const open = vi.fn();
    renderWithProviders(<TeamOverview overview={OVERVIEW} onOpenDetail={open} />);
    const changes = within(screen.getByRole('region', { name: 'Recent changes' }));
    expect(changes.getByText(/received Finance Analyst/)).toBeInTheDocument();
    expect(changes.getByText(/left the team/)).toHaveTextContent('Cas Former');
    expect(changes.queryByRole('button', { name: /Cas Former/ })).toBeNull();
    await userEvent.setup().click(changes.getByRole('button', { name: 'Ann Vos' }));
    expect(open).toHaveBeenCalledWith('user', 'a', 'Ann Vos');
  });

  it('says so when there are no roles, no changes, and the view is partial', () => {
    renderWithProviders(<TeamOverview overview={{ ...OVERVIEW, roles: [], changes: [], truncated: true }} />);
    expect(screen.getByText('Nobody in this team holds a business role yet.')).toBeInTheDocument();
    expect(screen.getByText('Nobody joined or left, and no business roles changed.')).toBeInTheDocument();
    expect(screen.getByText(/This overview is partial/)).toBeInTheDocument();
  });

  it('handles an empty team and a team of one', () => {
    const { unmount } = renderWithProviders(<TeamOverview overview={{ ...OVERVIEW, people: [], roles: [], changes: [], totalPeople: 0 }} />);
    expect(screen.getByText('Nobody is in this team right now.')).toBeInTheDocument();
    unmount();
    renderWithProviders(<TeamOverview overview={{ ...OVERVIEW, people: [ANN], totalPeople: 1 }} />);
    expect(screen.getByRole('heading', { name: /Your team/ })).toHaveTextContent('1 person');
  });
});

describe('UnitTeamPeople', () => {
  const mount = (authFetch, props = {}) => renderWithProviders(
    <UnitTeamPeople contextId="ctx-1" onOpenDetail={vi.fn()} {...props}><p>the people list</p></UnitTeamPeople>, { auth: { authFetch } },
  );

  it('shows the overview with the people list folded until asked for', async () => {
    mount(makeAuthFetch({ '/api/contexts/ctx-1/team-overview': OVERVIEW }));
    expect(await screen.findByRole('region', { name: 'Your team' })).toBeInTheDocument();
    expect(screen.queryByText('the people list')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: /People details/ }));
    expect(screen.getByText('the people list')).toBeInTheDocument();
  });

  it('lets the page open the fold', async () => {
    mount(makeAuthFetch({ '/api/contexts/ctx-1/team-overview': OVERVIEW }), { open: true, onOpenChange: vi.fn() });
    expect(await screen.findByText('the people list')).toBeInTheDocument();
  });

  it('falls back to the people list when the overview cannot be loaded', async () => {
    mount(makeAuthFetch(() => jsonResponse({ error: 'no' }, { ok: false, status: 500 })));
    expect(await screen.findByText('the people list')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Your team' })).toBeNull();
  });
});
