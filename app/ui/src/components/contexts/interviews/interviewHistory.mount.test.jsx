// @vitest-environment jsdom
// What the product owner missed in the second test round, mounted as the page
// uses it: the unit's other names as an "Also known as" fact (proposed ones
// dashed, confirmed inline, the page updating without a reload), and a person
// who left and came back — current in the members list with a "rejoined" marker,
// and in Previous members for the earlier stint. Invented names throughout.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement as h } from 'react';
import ContextDetailPage from '@ui/components/ContextDetailPage';
import ContextRelationshipsTab from '@ui/components/ContextRelationshipsTab';
import ClaimsProvider from './ClaimsProvider';
import { aliasFacts } from './claims.helpers';
import { earlierStintText, rejoinedText, rejoinedTitle } from './memberInterview.helpers';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, within, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const READER = { hasWildcard: false, permissions: new Set(['data.read']) };
const SRC = { interviewId: 'iv-1', intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01', fileName: 'gesprek.txt', proposedBy: 'model' };
const UNIT = {
  id: 'ctx-1', variant: 'synced', targetType: 'Principal', contextType: 'OrgUnit', contextCategory: 'OrganizationalUnit',
  displayName: 'HarbourOffice', directMemberCount: 1, totalMemberCount: 1, extendedAttributes: { aliases: ['HO'], sector: 'logistics' },
};

beforeEach(() => {
  global.fetch = vi.fn(async () => jsonResponse({}));
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('aliasFacts', () => {
  const alias = (id, value, status) => ({ id, claimKind: 'alias', value, status, ...SRC });

  it('the stored aliases and confirmed claims solid, then a writer\'s proposed ones; one per name', () => {
    const claims = [alias('a1', 'Havenkantoor', 'proposed'), alias('a2', 'Kade', 'confirmed'), alias('a3', 'h.o.', 'proposed'), alias('a4', 'Gone', 'rejected'), alias('a5', 'Kádé', 'edited')];
    expect(aliasFacts(UNIT, claims, true).map(f => [f.name, f.status, f.claim?.id ?? null])).toEqual([
      ['HO', 'confirmed', null], ['Kade', 'confirmed', 'a2'], ['Havenkantoor', 'proposed', 'a1'],
    ]);
    expect(aliasFacts(UNIT, claims, false).map(f => f.name)).toEqual(['HO', 'Kade']);
    expect(aliasFacts({ extendedAttributes: { aliases: 'not a list' } }, [], true)).toEqual([]);
    expect(aliasFacts(null, null, true)).toEqual([]);
  });
});

describe('the rejoin wording', () => {
  const rejoined = { claimId: 'c', value: 'architect', status: 'proposed', quote: 'Joris kwam terug als architect.', ...SRC,
    earlier: [{ value: 'junior developer', periodText: 'early years' }, { value: 'developer', periodFrom: '2019-01-01', periodTo: '2021-12-31' }] };

  it('marker, tooltip and the earlier-stint row', () => {
    expect(rejoinedText(rejoined)).toBe('rejoined · earlier: Junior developer → Developer');
    expect(rejoinedText({ ...rejoined, earlier: [] })).toBe('rejoined');
    expect(rejoinedTitle(rejoined)).toBe('“Joris kwam terug als architect.” — interview with Anna Voorbeeld, 2026-10-01\nEarlier: Junior developer (early years) → Developer (2019–2021)');
    expect(rejoinedTitle({ ...rejoined, earlier: [] })).toBe('“Joris kwam terug als architect.” — interview with Anna Voorbeeld, 2026-10-01');
    expect(earlierStintText({ rejoined })).toBe('Junior developer → Developer (earlier period)');
    expect(earlierStintText({ rejoined: { earlier: [] } })).toBe('earlier period');
  });
});

// ─── The detail page: Also known as, confirmed inline ─────────────────────
function pageApi() {
  const state = {
    unit: { ...UNIT, extendedAttributes: { ...UNIT.extendedAttributes } },
    claims: [
      { id: 'a-haven', claimKind: 'alias', status: 'proposed', value: 'Havenkantoor', relevance: 'high', quote: 'Het Havenkantoor is al lang klant.', ...SRC },
      { id: 'a-kade', claimKind: 'alias', status: 'proposed', value: 'Kade', relevance: 'high', quote: 'De Kade', ...SRC },
    ],
    patches: [],
    detailReads: 0,
  };
  const authFetch = makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    const patch = /^\/api\/contexts\/claims\/([^/]+)$/.exec(u);
    if (patch && opts.method === 'PATCH') {
      const body = JSON.parse(opts.body);
      state.patches.push({ id: patch[1], body });
      const c = state.claims.find(x => x.id === patch[1]);
      c.status = body.status;
      if (body.status === 'confirmed') state.unit.extendedAttributes.aliases = [...state.unit.extendedAttributes.aliases, c.value];
      return { claim: c, effect: { kind: 'alias' } };
    }
    if (u === '/api/contexts/ctx-1') { state.detailReads += 1; return { attributes: state.unit, subContexts: [] }; }
    if (u === '/api/contexts/ctx-1/claims') return { data: state.claims, accountableDoubt: null };
    if (u === '/api/contexts/ctx-1/interviews') return { data: [] };
    if (u.startsWith('/api/contexts/ctx-1/members')) return { total: 0, data: [] };
    if (u === '/api/contexts/ctx-1/previous-members') return { data: [], linkedResources: 0 };
    if (u === '/api/contexts/ctx-1/roles/suggestion') return jsonResponse(undefined, { status: 204 });
    if (u === '/api/contexts/ctx-1/roles') return [];
    if (u === '/api/contexts/ctx-1/relationships') return [];
    return undefined;
  });
  return { state, authFetch };
}

function mountPage(auth = {}) {
  const api = pageApi();
  renderWithProviders(h(ContextDetailPage, { contextId: 'ctx-1', onClose: vi.fn(), onOpenDetail: vi.fn() }), { auth: { authFetch: api.authFetch, ...auth } });
  return { ...api, user: userEvent.setup() };
}

const akaList = () => screen.findByRole('list', { name: 'Also known as' });

describe('Also known as, in the unit\'s facts', () => {
  it('confirmed names solid, the interview\'s proposals dashed with Confirm / Reject — and not again under More details', async () => {
    mountPage();
    const list = await akaList();
    expect(within(list).getAllByTestId('alias-confirmed').map(li => li.textContent)).toEqual(['HO']);
    await waitFor(() => expect(within(list).getAllByTestId('alias-proposed')).toHaveLength(2));
    const proposed = within(list).getAllByTestId('alias-proposed')[0];
    expect(proposed.querySelector('span').className).toContain('border-dashed');
    expect(proposed.querySelector('span')).toHaveAttribute('title', 'Proposed — “Het Havenkantoor is al lang klant.” — interview with Anna Voorbeeld, 2026-10-01');
    const details = screen.getByRole('region', { name: 'More details' });
    expect(within(details).queryByText('Also known as')).toBeNull();
  });

  it('Confirm makes it a confirmed name at once — the context is re-read without the page reloading', async () => {
    const { state, user } = mountPage();
    const list = await akaList();
    await waitFor(() => expect(within(list).getAllByTestId('alias-proposed')).toHaveLength(2));
    const reads = state.detailReads;
    await user.click(within(list).getByRole('button', { name: 'Confirm “Havenkantoor” as another name' }));
    expect(state.patches).toEqual([{ id: 'a-haven', body: { status: 'confirmed' } }]);
    await waitFor(() => expect(state.detailReads).toBe(reads + 1));
    await waitFor(() => expect(within(list).getAllByTestId('alias-confirmed').map(li => li.textContent)).toEqual(['HO', 'Havenkantoor']));
    // the same list element: the page did not go through its loading state
    expect(list.isConnected).toBe(true);
    expect(screen.queryByText('Loading context details...')).toBeNull();
  });

  it('Reject removes the proposal', async () => {
    const { state, user } = mountPage();
    const list = await akaList();
    await waitFor(() => expect(within(list).getAllByTestId('alias-proposed')).toHaveLength(2));
    await user.click(within(list).getByRole('button', { name: 'Reject “Kade”' }));
    expect(state.patches).toEqual([{ id: 'a-kade', body: { status: 'rejected' } }]);
    await waitFor(() => expect(within(list).getAllByTestId('alias-proposed').map(li => li.textContent)).toEqual(['HavenkantoorConfirmReject']));
  });

  it('a reader sees the confirmed names only, without buttons', async () => {
    mountPage(READER);
    const list = await akaList();
    await waitFor(() => expect(within(list).getAllByTestId('alias-confirmed').map(li => li.textContent)).toEqual(['HO']));
    expect(within(list).queryByTestId('alias-proposed')).toBeNull();
    expect(within(list).queryByRole('button')).toBeNull();
  });
});

// ─── Members: left once, back now ─────────────────────────────────────────
const REJOINED = {
  claimId: 'rh-joris-now', interviewId: 'iv-1', value: 'architect within CCoE', status: 'proposed', membershipStatus: 'rejoined',
  periodText: 'nu', quote: 'Joris Jansen begon als junior en is sinds ongeveer een half jaar terug, nu als architect binnen het CCoE.', ...SRC,
  earlier: [{ claimId: 'rh-joris-junior', value: 'junior developer', status: 'proposed', periodText: 'sinds ongeveer een half jaar terug', ...SRC }],
};
const MEMBERS = [
  { id: 'p-joris', displayName: 'Joris Jansen', email: 'joris@example.test', principalType: 'User', accountEnabled: true,
    interview: { left: null, rejoined: REJOINED, role: { ...REJOINED, history: [...REJOINED.earlier, REJOINED] } } },
  { id: 'p-femke', displayName: 'Femke de Groot', email: 'femke@example.test', principalType: 'User', accountEnabled: true,
    interview: { left: null, rejoined: null, role: { claimId: 'r-femke', interviewId: 'iv-1', value: 'data mining', status: 'proposed', ...SRC, history: [] } } },
];
const PREVIOUS = {
  linkedResources: 0,
  data: [
    { key: 'principalId:p-joris', principalId: 'p-joris', identityId: null, displayName: 'Joris Jansen', accountDeleted: false, stint: 'earlier', nowMember: true,
      left: null, rejoined: REJOINED, role: { ...REJOINED.earlier[0], history: REJOINED.earlier }, liveEntitlements: 7, linkedEntitlements: null },
    { key: 'name:stijn', principalId: null, identityId: null, displayName: 'Stijn', accountDeleted: false, stint: 'left', nowMember: false,
      left: { claimId: 'm-stijn', interviewId: 'iv-1', membershipStatus: 'former', status: 'proposed', ...SRC }, role: null, rejoined: null, liveEntitlements: null, linkedEntitlements: null },
    { key: 'name:roos', principalId: null, identityId: null, displayName: 'Roos', accountDeleted: false, stint: 'earlier', nowMember: false,
      left: null, rejoined: { ...REJOINED, claimId: 'm-roos', earlier: [] }, role: null, liveEntitlements: null, linkedEntitlements: null },
  ],
};

function mountMembers(auth = {}) {
  const authFetch = makeAuthFetch((url) => {
    const u = String(url);
    if (u === '/api/contexts/ctx-1/claims') return { data: [], accountableDoubt: null };
    if (u === '/api/contexts/ctx-1/interviews') return { data: [] };
    if (u === '/api/contexts/ctx-1/previous-members') return PREVIOUS;
    return undefined;
  });
  const props = {
    subContexts: [], sectionIds: {}, contextId: 'ctx-1', attrs: UNIT, canEditMembers: false,
    includeDescendants: false, onIncludeDescendantsChange: vi.fn(), memberSearch: '', onMemberSearchChange: vi.fn(),
    members: MEMBERS, memberTotal: 2, membersLoading: false, membersError: null, memberPage: 0, onMemberPageChange: vi.fn(),
    pageSize: 50, authFetch, onMembersChanged: vi.fn(), onOpenDetail: vi.fn(),
  };
  renderWithProviders(h(ClaimsProvider, { contextId: 'ctx-1' }, h(ContextRelationshipsTab, props)), { auth: { authFetch, ...auth } });
  return { user: userEvent.setup() };
}

const memberRow = (name) => screen.getAllByRole('row').find(r => r.textContent.startsWith(name));

describe('a member who left and came back', () => {
  it('the current row: the role now, and "rejoined · earlier: Junior developer" with the quote; nobody else is marked', async () => {
    mountMembers();
    const row = memberRow('Joris Jansen');
    expect(row).toHaveAttribute('id', 'context-member-p-joris');
    expect(within(row).getByTestId('member-interview-role')).toHaveTextContent('architect within CCoE');
    const flag = within(row).getByTestId('member-rejoined-flag');
    expect(flag).toHaveTextContent('rejoined · earlier: Junior developer');
    expect(flag.getAttribute('title')).toContain('is sinds ongeveer een half jaar terug');
    expect(flag.className).toContain('border-dashed');
    expect(within(memberRow('Femke de Groot')).queryByTestId('member-rejoined-flag')).toBeNull();
  });

  it('Previous members: the earlier stint, "now a member again" pointing at the current row; a left row as before', async () => {
    const { user } = mountMembers();
    const section = await screen.findByRole('region', { name: 'Previous members' });
    const rows = within(section).getAllByTestId('previous-member');
    expect(rows.map(r => [r.dataset.stint, ...[...r.querySelectorAll('td')].map(td => td.textContent)])).toEqual([
      ['earlier', 'Joris Jansen', 'Junior developer (earlier period)', 'left, came back', 'interview with Anna Voorbeeld, 2026-10-01', 'now a member again'],
      ['left', 'Stijn', '', 'former member', 'interview with Anna Voorbeeld, 2026-10-01', 'no account found'],
      ['earlier', 'Roos', 'earlier period', 'left, came back', 'interview with Anna Voorbeeld, 2026-10-01', 'back again, says the interview'],
    ]);
    await user.click(within(rows[0]).getByTestId('previous-member-now-member'));
    const current = memberRow('Joris Jansen');
    expect(current.scrollIntoView).toHaveBeenCalled();
    expect(current.className).toContain('bg-sky-50');
  });

  it('a reader sees the marker as text', async () => {
    mountMembers(READER);
    expect(within(memberRow('Joris Jansen')).getByTestId('member-rejoined-flag').tagName).toBe('SPAN');
  });
});
