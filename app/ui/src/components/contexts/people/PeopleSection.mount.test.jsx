// @vitest-environment jsdom
// The People overview: one row per person, as GET /api/contexts/:id/people
// sends it — the status in one vocabulary, the role here, the sources, what they
// still hold, the roles they answer for — with the Current / Former / All
// filters, "To decide" when there is anything to decide, the search, the pages,
// and Edit members on a unit created here. Invented names throughout. The claim
// icons' popovers are PersonClaims.mount.test.jsx's.
import { describe, it, expect, vi } from 'vitest';
import { createElement as h, useState } from 'react';
import PeopleSection from './PeopleSection';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, within, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const UNIT = { id: 'c-unit', displayName: 'Harbour Office', contextCategory: 'OrganizationalUnit', targetType: 'Principal', scopeSystemName: 'Customer list (upload)' };
const DECISION = { by: 'analyst@example.test', at: '2026-10-23T10:00:00Z', overrides: 'Customer list (upload)', claimId: 'c-bob' };
const person = (over) => ({ roles: [], role: null, rejoined: null, left: null, decision: null, stillListed: false, sources: ['list'], claims: [], contradictions: [], liveEntitlements: 0, linkedEntitlements: 0, ...over });

const ANN = person({ key: 'principalId:p-ann', status: 'current', principalId: 'p-ann', displayName: 'Ann Example', roles: ['Accountable', 'Responsible'], role: { value: 'Lead architect', status: 'confirmed' }, sources: ['list', 'interview'], liveEntitlements: 1234, linkedEntitlements: 3 });
const CLEO = person({ key: 'principalId:p-cleo', status: 'cameBack', principalId: 'p-cleo', displayName: 'Cleo Back', role: { value: 'architect', status: 'proposed' },
  rejoined: { quote: 'Cleo is back since May', intervieweeName: 'Iris Interviewee', interviewedAt: '2026-10-01', earlier: [{ value: 'junior developer' }, { value: 'tester' }] } });
const DANA = person({ key: 'identityId:i-dana', status: 'notConfirmed', identityId: 'i-dana', displayName: 'Dana Said', sources: ['interview', 'text'], contradictions: ['memberNotListed:m-dana'] });
const BOB = person({ key: 'principalId:p-bob', status: 'leftDecided', former: true, principalId: 'p-bob', displayName: 'Bob Sample', decision: DECISION, stillListed: true, sources: ['list', 'file'], liveEntitlements: 210, linkedEntitlements: 0 });
const KAREL = person({ key: 'name:karel', status: 'left', former: true, displayName: 'Karel', sources: ['interview'], liveEntitlements: null, linkedEntitlements: null,
  left: { quote: 'Karel has left', intervieweeName: 'Iris Interviewee', interviewedAt: '2026-10-01' } });

const PAGES = { current: [ANN, CLEO, DANA], former: [BOB, KAREL], all: [ANN, CLEO, DANA, BOB, KAREL], decide: [DANA] };
const COUNTS = { current: 3, former: 2, all: 5, decide: 1 };

function api({ counts = COUNTS, people = (url) => PAGES[new URL(url, 'http://x').searchParams.get('filter')], total, fail = false } = {}) {
  const urls = [];
  const authFetch = makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('/api/contexts/c-unit/people')) {
      urls.push(u);
      if (fail) return jsonResponse({ error: 'boom' }, { ok: false, status: 500 });
      const data = people(u);
      return { data, total: total ?? data.length, counts, linkedResources: 5 };
    }
    if (opts.method === 'DELETE') return jsonResponse(undefined, { status: 204 });
    if (u.startsWith('/api/users?')) return { data: [] };
    return undefined;
  });
  return { authFetch, urls };
}

function mount({ props = {}, auth = {}, ...opts } = {}) {
  const { authFetch, urls } = api(opts);
  const onOpenDetail = vi.fn();
  const onMembersChanged = vi.fn();
  function Page() {
    const [filter, setFilter] = useState('current');
    const [version, setVersion] = useState(0);
    return h('div', null,
      h('button', { type: 'button', onClick: () => setVersion(v => v + 1) }, 'something changed'),
      h(PeopleSection, { attrs: UNIT, filter, onFilterChange: setFilter, version, onOpenDetail, onMembersChanged, ...props }));
  }
  const view = renderWithProviders(h(Page), { auth: { authFetch, ...auth } });
  return { authFetch, urls, onOpenDetail, onMembersChanged, user: userEvent.setup(), ...view };
}

const rows = () => screen.getAllByTestId('person-row');
const row = (name) => rows().find(r => r.textContent.startsWith(name));
const cells = (r) => [...r.querySelectorAll('td')].map(td => td.textContent);
const URL0 = (filter) => `/api/contexts/c-unit/people?filter=${filter}&limit=100&offset=0`;

describe('one row per person', () => {
  it('the current people: name and roles, status, role here, sources, what they hold — in the API\'s order', async () => {
    const { urls } = mount();
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(urls).toEqual([URL0('current')]);
    expect(rows().map(cells)).toEqual([
      ['Ann ExampleAccountableResponsibleCurrent', 'Current', 'Lead architect', 'listinterview', '1,2343 here', ''],
      ['Cleo BackCame back', 'Came back', 'architectearlier: Junior developer → Tester', 'list', '0', ''],
      ['Dana SaidNot confirmed', 'Not confirmed', '', 'interviewnotes', '0', ''],
    ]);
    expect(screen.getByRole('heading', { name: /People/ })).toHaveTextContent('People 3 current · 2 former');
  });

  it('each status chip says why; a proposed role reads dashed; the source chips say where it comes from', async () => {
    mount();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const chip = (r) => within(r).getAllByTestId('person-status')[1];
    expect(chip(row('Ann Example'))).not.toHaveAttribute('title');
    expect(chip(row('Cleo Back'))).toHaveAttribute('title', '“Cleo is back since May” — interview with Iris Interviewee, 2026-10-01\nEarlier: Junior developer → Tester');
    expect(chip(row('Dana Said'))).toHaveAttribute('title', 'A source says they are in it, but the member list does not list them');
    expect(within(row('Cleo Back')).getByText('architect').className).toContain('border-dashed');
    expect(within(row('Ann Example')).getByText('Lead architect').className).not.toContain('border-dashed');
    expect(within(row('Ann Example')).getByText('list')).toHaveAttribute('title', 'Listed by Customer list (upload)');
    expect(within(row('Dana Said')).getByText('notes')).toHaveAttribute('title', 'In notes someone added');
  });

  it('the former: left (decided) with the decision, left with what was said, a dash for nobody matched', async () => {
    const { urls, user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Former 2' }));
    await waitFor(() => expect(rows().map(r => r.textContent.split(/Left/)[0])).toEqual(['Bob Sample', 'Karel']));
    expect(urls.at(-1)).toBe(URL0('former'));
    const bob = within(row('Bob Sample')).getAllByTestId('person-status')[1];
    expect(bob).toHaveTextContent('Left (decided)');
    expect(bob).toHaveAttribute('data-status', 'leftDecided');
    expect(bob.getAttribute('title')).toBe('Decided by analyst@example.test, 2026-10-23: the interview is right — Customer list (upload) still lists them. Still listed in the source — remove it there or re-import without them.');
    expect(cells(row('Bob Sample')).slice(3, 5)).toEqual(['listfile', '210']);
    expect(within(row('Karel')).getAllByTestId('person-status')[1]).toHaveAttribute('title', '“Karel has left” — interview with Iris Interviewee, 2026-10-01');
    expect(within(row('Karel')).getByTestId('person-access')).toHaveTextContent(/^–$/);
  });

  it('the name opens the account, else the person; a name nobody matched, or a page that may not link, is text', async () => {
    const { onOpenDetail, user } = mount();
    await waitFor(() => expect(rows()).toHaveLength(3));
    await user.click(screen.getByRole('button', { name: 'Ann Example' }));
    await user.click(screen.getByRole('button', { name: 'Dana Said' }));
    expect(onOpenDetail.mock.calls).toEqual([['user', 'p-ann', 'Ann Example'], ['identity', 'i-dana', 'Dana Said']]);
    await user.click(screen.getByRole('button', { name: 'All 5' }));
    await waitFor(() => expect(rows()).toHaveLength(5));
    expect(screen.queryByRole('button', { name: 'Karel' })).toBeNull();
  });

  it('without a detail handler (a read-only shell) every name is text', async () => {
    mount({ props: { onOpenDetail: undefined } });
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.queryByRole('button', { name: 'Ann Example' })).toBeNull();
  });
});

describe('filters, search and pages', () => {
  it('Current, Former, All with their counts; the pressed one is the filter asked for', async () => {
    const { urls, user } = mount();
    const group = await screen.findByRole('group', { name: 'Show' });
    expect(within(group).getAllByRole('button').map(b => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Current 3', 'true'], ['Former 2', 'false'], ['All 5', 'false'], ['To decide 1', 'false'],
    ]);
    await user.click(within(group).getByRole('button', { name: 'To decide 1' }));
    await waitFor(() => expect(urls.at(-1)).toBe(URL0('decide')));
    expect(within(group).getByRole('button', { name: 'To decide 1' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(rows().map(r => r.dataset.key)).toEqual(['identityId:i-dana']));
  });

  it('no "To decide" when there is nothing to decide', async () => {
    mount({ counts: { ...COUNTS, decide: 0 } });
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.queryByRole('button', { name: /To decide/ })).toBeNull();
  });

  it('the search is sent once typing pauses, from the first page', async () => {
    const { urls, user } = mount();
    await waitFor(() => expect(urls).toHaveLength(1));
    await user.type(screen.getByRole('searchbox', { name: 'Search people' }), 'ann');
    await waitFor(() => expect(urls.at(-1)).toBe('/api/contexts/c-unit/people?filter=current&limit=100&offset=0&search=ann'));
    expect(urls.filter(u => u.includes('search=a&') || u.endsWith('search=a'))).toEqual([]);
  });

  it('pages of 100: Next asks the second page, Previous the first', async () => {
    const { urls, user } = mount({ total: 250 });
    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(urls.at(-1)).toBe('/api/contexts/c-unit/people?filter=current&limit=100&offset=100'));
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Former 2' }));
    await waitFor(() => expect(urls.at(-1)).toBe('/api/contexts/c-unit/people?filter=former&limit=100&offset=0'));
  });

  it('a change elsewhere on the page reads the list again', async () => {
    const { urls, user } = mount();
    await waitFor(() => expect(urls).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'something changed' }));
    await waitFor(() => expect(urls).toHaveLength(2));
    expect(urls).toEqual([URL0('current'), URL0('current')]);
  });
});

describe('loading, failing, empty', () => {
  it('says it is loading while the first read is out', () => {
    const pending = makeAuthFetch(() => new Promise(() => {}));
    renderWithProviders(h(PeopleSection, { attrs: UNIT, filter: 'current', onFilterChange: vi.fn() }), { auth: { authFetch: pending } });
    expect(screen.getByText('Loading people…')).toBeInTheDocument();
  });

  it('a failed read says so, never passes for an empty unit', async () => {
    mount({ fail: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('People could not be loaded (HTTP 500).');
  });

  it('nobody here says so; an application with nobody named shows no section at all', async () => {
    const empty = { counts: { current: 0, former: 0, all: 0, decide: 0 }, people: () => [] };
    const { unmount } = mount(empty);
    expect(await screen.findByText('Nobody here.')).toBeInTheDocument();
    unmount();
    const { urls } = mount({ ...empty, props: { hideWhenEmpty: true } });
    await waitFor(() => expect(urls).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'People' })).toBeNull());
  });
});

describe('Edit members, on a unit created here', () => {
  it('is not offered elsewhere', async () => {
    mount();
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.queryByRole('button', { name: 'Edit members' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('adds the add box and a Remove on every row its list holds; Remove deletes and reads again', async () => {
    const { authFetch, urls, onMembersChanged, user } = mount({ props: { canEditMembers: true } });
    await waitFor(() => expect(rows()).toHaveLength(3));
    await user.click(screen.getByRole('button', { name: 'Edit members' }));
    expect(screen.getByRole('button', { name: 'Done' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox', { name: /to add$/ })).toBeInTheDocument();
    expect(rows().map(r => !!within(r).queryByRole('button', { name: 'Remove' }))).toEqual([true, true, false]);
    const before = urls.length;
    await user.click(within(row('Cleo Back')).getByRole('button', { name: 'Remove' }));
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/c-unit/members/p-cleo', { method: 'DELETE' });
    await waitFor(() => expect(urls).toHaveLength(before + 1));
    expect(onMembersChanged).toHaveBeenCalledTimes(1);
  });
});
