// @vitest-environment jsdom
// What the product owner's test interview asked for, mounted the way the page
// uses it: What we know folded to one line; the review list with what matters
// first and the noise folded and rejectable in bulk; the transcript with the
// claims highlighted; and in the members lists the role and "left" from the
// interviews, plus the previous members with what they still hold.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement as h } from 'react';
import ContextProfile from '@ui/components/contexts/profiles/ContextProfile';
import { PROFILES } from '@ui/components/contexts/profiles/profiles';
import ContextRelationshipsTab from '@ui/components/ContextRelationshipsTab';
import ClaimsProvider from './ClaimsProvider';
import { OPEN_KEY } from './WhatWeKnow';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, within, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const UNIT = { id: 'c-unit', displayName: 'Harbour Authority', contextCategory: 'OrganizationalUnit', targetType: 'Principal', directMemberCount: 2 };
const SRC = { interviewId: 'iv-1', intervieweeName: 'Piet de Vries', interviewedAt: '2026-10-01', fileName: 'gesprek.vtt', proposedBy: 'model' };

const TRANSCRIPT = [
  'Interviewer: Who works on the Harbour Authority account?',
  'Piet de Vries: I lead it. Jan Smit just left the account last month,',
  'and Karel worked on it in the early years.',
  'Interviewer: Anything else?',
  'Piet de Vries: The canteen is great. Everyone calls it the Port Co.',
].join('\n');

const at = (claimId, quote) => {
  const start = TRANSCRIPT.indexOf(quote);
  return { claimId, start, end: start + quote.length };
};

const CLAIMS = [
  { id: 'm-jan', claimKind: 'membership', status: 'proposed', principalId: 'p-jan', subjectName: 'Jan Smit', subjectDisplayName: 'Jan Smit', attribute: 'left', value: 'left the account', periodText: 'last month', relevance: 'high', quote: 'Jan Smit just left the account last month', ...SRC },
  { id: 'm-karel', claimKind: 'membership', status: 'proposed', subjectName: 'Karel', attribute: 'former', value: 'worked on it in the early years', relevance: 'high', quote: 'last month,\nand Karel worked on it', ...SRC },
  { id: 'r-piet', claimKind: 'role', status: 'confirmed', principalId: 'p-piet', subjectName: 'interviewee', subjectDisplayName: 'Piet de Vries', attribute: 'member', value: 'Lead', relevance: 'high', quote: 'I lead it.', ...SRC },
  { id: 'd-canteen', claimKind: 'description', status: 'proposed', value: 'Has a great canteen', relevance: 'low', quote: 'The canteen is great.', ...SRC },
  { id: 'p-weather', claimKind: 'property', status: 'proposed', attribute: 'weather', value: 'grey', relevance: 'low', quote: 'Anything else?', ...SRC },
  { id: 'a-port', claimKind: 'alias', status: 'proposed', value: 'Port Co', relevance: 'high', quote: 'Everyone calls it the Port Co', ...SRC },
  { id: 'd-old', claimKind: 'description', status: 'rejected', value: 'Who works there', quote: 'Who works on the Harbour Authority account?', ...SRC },
];
const HIGHLIGHTS = [
  at('d-old', 'Who works on the Harbour Authority account?'), at('r-piet', 'I lead it.'),
  at('m-jan', 'Jan Smit just left the account last month'), at('m-karel', 'last month,\nand Karel worked on it'),
  at('p-weather', 'Anything else?'), at('d-canteen', 'The canteen is great.'), at('a-port', 'Everyone calls it the Port Co'),
];
const INTERVIEW = { id: 'iv-1', ...SRC, extractionStatus: 'done', proposed: 5, confirmed: 1 };

function api({ claims = CLAIMS, previous = { data: [], linkedResources: 0 } } = {}) {
  const state = { claims: claims.map(c => ({ ...c })), patches: [], rejects: [] };
  const authFetch = makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    const patch = /^\/api\/contexts\/claims\/([^/]+)$/.exec(u);
    if (patch && opts.method === 'PATCH') {
      const body = JSON.parse(opts.body);
      state.patches.push({ id: patch[1], body });
      const c = state.claims.find(x => x.id === patch[1]);
      c.status = body.status;
      return { claim: c, effect: { kind: 'none' } };
    }
    if (u === '/api/contexts/c-unit/claims/reject') {
      const body = JSON.parse(opts.body);
      state.rejects.push(body);
      const hit = state.claims.filter(c => c.status === 'proposed' && (!body.kind || c.claimKind === body.kind) && (!body.relevance || (c.relevance || 'high') === body.relevance));
      for (const c of hit) c.status = 'rejected';
      return { rejected: hit.length, ids: hit.map(c => c.id) };
    }
    if (u === '/api/contexts/c-unit/claims') return { data: state.claims, accountableDoubt: null };
    if (u === '/api/contexts/c-unit/interviews') return { data: [INTERVIEW] };
    if (u === '/api/contexts/c-unit/interviews/iv-1') return { ...INTERVIEW, transcript: TRANSCRIPT, highlights: HIGHLIGHTS };
    if (u === '/api/contexts/c-unit/previous-members') return previous;
    if (u === '/api/contexts/c-unit/roles/suggestion') return jsonResponse(undefined, { status: 204 });
    if (u === '/api/contexts/c-unit/roles') return [];
    if (u === '/api/contexts/c-unit/relationships') return [];
    return undefined;
  });
  return { authFetch, state };
}

const READER = { hasWildcard: false, permissions: new Set(['data.read']) };

function mountProfile({ auth = {}, open = true, ...opts } = {}) {
  window.sessionStorage.clear();
  if (open) window.sessionStorage.setItem(OPEN_KEY('c-unit'), '1');
  const { authFetch, state } = api(opts);
  renderWithProviders(h(ContextProfile, { profile: PROFILES.OrganizationalUnit, attrs: UNIT }), { auth: { authFetch, ...auth } });
  return { authFetch, state, user: userEvent.setup() };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const region = () => screen.findByRole('region', { name: 'What we know' });

describe('What we know, folded', () => {
  it('starts folded to one line of counts, opens on click and remembers that for this context', async () => {
    mountProfile({ open: false });
    const r = await region();
    const toggle = within(r).getByRole('button', { expanded: false });
    await waitFor(() => expect(within(r).getByTestId('what-we-know-summary')).toHaveTextContent('1 fact · 1 person · 5 proposed to review'));
    expect(within(r).queryByRole('list', { name: 'Claims to review' })).toBeNull();
    await userEvent.setup().click(toggle);
    expect(within(r).getByRole('list', { name: 'Claims to review' })).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(window.sessionStorage.getItem(OPEN_KEY('c-unit'))).toBe('1');
    await userEvent.setup().click(toggle);
    expect(window.sessionStorage.getItem(OPEN_KEY('c-unit'))).toBe('0');
  });

  it('a browser that refuses session storage just starts folded', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      const { authFetch } = api();
      renderWithProviders(h(ContextProfile, { profile: PROFILES.OrganizationalUnit, attrs: UNIT }), { auth: { authFetch } });
      const r = await region();
      const toggle = within(r).getByRole('button', { expanded: false });
      await userEvent.setup().click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});

describe('the review list — what matters first', () => {
  it('lists the high tier, folds the low one under "Less relevant (2)"', async () => {
    mountProfile();
    const list = await screen.findByRole('list', { name: 'Claims to review' });
    expect(within(list).getAllByTestId('claim-review-row').map(r => r.textContent.split('Quote')[0])).toEqual([
      'MembershipJan Smit — left the account (left)last month',
      'MembershipKarel — worked on it in the early years (former member)',
      'Also known asPort Co',
    ]);
    const less = screen.getByTestId('less-relevant');
    expect(less).not.toHaveAttribute('open');
    expect(within(less).getByText('Less relevant (2)')).toBeInTheDocument();
    expect(within(less).getAllByTestId('claim-review-row')).toHaveLength(2);
  });

  it('"Reject all less relevant" and "Reject all descriptions" each send one request', async () => {
    const { state, user } = mountProfile();
    await user.click(await screen.findByRole('button', { name: 'Reject all less relevant (2)' }));
    await waitFor(() => expect(screen.queryByTestId('less-relevant')).toBeNull());
    expect(state.rejects).toEqual([{ relevance: 'low' }]);
    expect(screen.queryByRole('button', { name: /Reject all descriptions/ })).toBeNull();
    expect(state.patches).toEqual([]);
  });

  it('"Reject all descriptions" counts the proposed descriptions only', async () => {
    const { state, user } = mountProfile();
    await user.click(await screen.findByRole('button', { name: 'Reject all descriptions (1)' }));
    await waitFor(() => expect(state.rejects).toEqual([{ kind: 'description' }]));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reject all less relevant (1)' })).toBeInTheDocument());
  });
});

describe('the transcript', () => {
  it('each interview in the list opens its own transcript', async () => {
    const { user } = mountProfile();
    await user.click(await screen.findByRole('button', { name: 'View the transcript of the interview with Piet de Vries, 2026-10-01' }));
    const panel = await screen.findByRole('dialog', { name: 'Transcript' });
    expect(panel).toHaveTextContent('Interview with Piet de Vries, 2026-10-01 · gesprek.vtt');
  });

  async function openTranscript(user) {
    await user.click(within(await region()).getByRole('button', { name: 'View transcript' }));
    return screen.findByRole('dialog', { name: 'Transcript' });
  }

  it('reads as a dialogue with the quotes highlighted, a colour per kind and a fill per status, and a legend', async () => {
    const { user } = mountProfile();
    const panel = await openTranscript(user);
    expect(panel).toHaveFocus();
    const turns = await within(panel).findAllByTestId('transcript-turn');
    expect(turns.map(t => t.firstChild.textContent)).toEqual(['Interviewer', 'Piet de Vries', '', 'Interviewer', 'Piet de Vries']);
    const legend = within(panel).getByRole('group', { name: 'Legend' });
    expect(legend).toHaveTextContent('RoleRole historyMembershipAlso known asPropertyDescriptionproposedconfirmedrejected');
    const lead = within(panel).getByRole('button', { name: 'Role, confirmed: Piet de Vries — Lead (works on it)' });
    expect(lead.className).toContain('bg-blue-200');
    expect(lead.className).not.toContain('decoration-dashed');
    const old = within(panel).getByRole('button', { name: /^Description, rejected/ });
    expect(old.className).toContain('line-through');
    const alias = within(panel).getByRole('button', { name: 'Also known as, proposed: Port Co' });
    expect(alias.className).toContain('decoration-dashed');
    expect(alias.className).toContain('bg-teal-50');
  });

  it('a quote over two turns is highlighted in both; where two quotes overlap the piece names both claims', async () => {
    const { user } = mountProfile();
    const panel = await openTranscript(user);
    await within(panel).findAllByTestId('transcript-turn');
    const karel = within(panel).getAllByRole('button', { name: /Karel/ });
    // Karel's quote runs from the end of one turn into the next; 'last month' is Jan's too.
    expect(karel.map(m => m.textContent)).toEqual(['last month', ',', 'and Karel worked on it']);
    expect(karel.map(m => m.getAttribute('data-claim-ids'))).toEqual(['m-jan m-karel', 'm-karel', 'm-karel']);
    // The overlap takes the more specific (shorter) quote's style — Karel's over Jan's — and is outlined as shared.
    expect(karel[0].className).toContain('bg-purple-50');
    expect(karel[0].className).toContain('outline');
  });

  it('a highlight opens its claim card, where an analyst decides it — by click or by keyboard', async () => {
    const { state, user } = mountProfile();
    const panel = await openTranscript(user);
    const alias = await within(panel).findByRole('button', { name: 'Also known as, proposed: Port Co' });
    alias.focus();
    await user.keyboard('{Enter}');
    const card = within(panel).getByTestId('transcript-claim-card');
    expect(card).toHaveTextContent('Also known asPort Coproposed');
    await user.click(within(card).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(state.patches).toEqual([{ id: 'a-port', body: { status: 'confirmed' } }]));
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Also known as, confirmed: Port Co' })).toBeInTheDocument());
  });

  it('"In transcript" in the review list opens the panel at the quote and makes it pulse; Escape closes it', async () => {
    const { user } = mountProfile();
    const list = await screen.findByRole('list', { name: 'Claims to review' });
    await user.click(within(list).getByRole('button', { name: 'Show “Jan Smit just left the account last month” in the transcript' }));
    const panel = await screen.findByRole('dialog', { name: 'Transcript' });
    const [jan] = await within(panel).findAllByRole('button', { name: /^Membership, proposed: Jan Smit/ });
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    expect(Element.prototype.scrollIntoView.mock.contexts[0]).toBe(jan);
    await waitFor(() => expect(jan.className).toContain('animate-pulse'));
    expect(within(panel).getByTestId('transcript-claim-card')).toHaveTextContent('Jan Smit — left the account (left)');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Transcript' })).toBeNull();
  });

  it('a reader sees no transcript and no way to open one', async () => {
    const { authFetch } = mountProfile({ auth: READER, claims: CLAIMS.filter(c => c.status === 'confirmed') });
    const r = await region();
    expect(within(r).queryByRole('button', { name: 'View transcript' })).toBeNull();
    expect(authFetch.mock.calls.map(c => c[0])).not.toContain('/api/contexts/c-unit/interviews/iv-1');
  });
});

// ─── The members lists ────────────────────────────────────────────────────
const MEMBERS = [
  {
    id: 'p-jan', displayName: 'Jan Smit', email: 'jan@example.test', principalType: 'User', accountEnabled: true,
    interview: { role: null, left: { claimId: 'm-jan', interviewId: 'iv-1', membershipStatus: 'left', status: 'proposed', periodText: 'last month', quote: 'Jan Smit just left the account last month', ...SRC } },
  },
  {
    id: 'p-piet', displayName: 'Piet de Vries', email: 'piet@example.test', principalType: 'User', accountEnabled: true,
    interview: {
      left: null,
      role: { claimId: 'r-piet', interviewId: 'iv-1', value: 'Lead architect', status: 'confirmed', quote: 'I lead it.', ...SRC,
        history: [{ value: 'Junior', periodText: 'early years' }, { value: 'Lead architect', periodText: 'now' }] },
    },
  },
];
const PREVIOUS = {
  linkedResources: 40,
  data: [
    { key: 'principalId:p-bram', principalId: 'p-bram', identityId: null, displayName: 'Bram Test', accountDeleted: false, liveEntitlements: 12, linkedEntitlements: 3,
      left: { claimId: 'm-bram', interviewId: 'iv-1', membershipStatus: 'former', status: 'confirmed', periodText: 'early years', quote: 'Bram worked on it', ...SRC },
      role: { claimId: 'r-bram', interviewId: 'iv-1', value: 'Junior', status: 'proposed', ...SRC, history: [{ value: 'Junior' }] } },
    { key: 'name:karel', principalId: null, identityId: null, displayName: 'Karel', accountDeleted: false, liveEntitlements: null, linkedEntitlements: null,
      left: { claimId: 'm-karel', interviewId: 'iv-1', membershipStatus: 'former', status: 'proposed', periodText: null, ...SRC }, role: null },
    { key: 'principalId:p-yara', principalId: 'p-yara', identityId: null, displayName: 'Yara Weg', accountDeleted: true, liveEntitlements: 0, linkedEntitlements: 0,
      left: { claimId: 'm-yara', interviewId: 'iv-1', membershipStatus: 'left', status: 'confirmed', ...SRC }, role: null },
  ],
};

function mountMembers({ auth = {}, previous = PREVIOUS } = {}) {
  window.sessionStorage.clear();
  const { authFetch } = api({ previous });
  const onOpenDetail = vi.fn();
  const props = {
    subContexts: [], sectionIds: {}, contextId: 'c-unit', attrs: UNIT, canEditMembers: false,
    includeDescendants: false, onIncludeDescendantsChange: vi.fn(), memberSearch: '', onMemberSearchChange: vi.fn(),
    members: MEMBERS, memberTotal: 2, membersLoading: false, membersError: null, memberPage: 0, onMemberPageChange: vi.fn(),
    pageSize: 50, authFetch, onMembersChanged: vi.fn(), onOpenDetail,
  };
  renderWithProviders(h(ClaimsProvider, { contextId: 'c-unit' }, h(ContextRelationshipsTab, props)), { auth: { authFetch, ...auth } });
  return { authFetch, onOpenDetail, user: userEvent.setup() };
}

const memberRow = (name) => screen.getAllByRole('row').find(r => r.textContent.startsWith(name));

describe('the members list — role and "left" from the interviews', () => {
  it('a Role column with the latest role, the history in its tooltip; a proposed one dashed', async () => {
    mountMembers();
    expect(screen.getByRole('columnheader', { name: 'Role' })).toBeInTheDocument();
    const role = within(memberRow('Piet de Vries')).getByTestId('member-interview-role');
    expect(role).toHaveTextContent('Lead architect');
    expect(role).toHaveAttribute('title', 'Junior (early years) → Lead architect (now)');
    expect(role.className).not.toContain('border-dashed');
  });

  it('a current member an interview says left is flagged, the quote as tooltip; the flag opens the transcript, not the member', async () => {
    const { onOpenDetail, user } = mountMembers();
    const flag = within(memberRow('Jan Smit')).getByTestId('member-left-flag');
    expect(flag).toHaveTextContent('Interview: left (last month)');
    expect(flag).toHaveAttribute('title', '“Jan Smit just left the account last month” — interview with Piet de Vries, 2026-10-01');
    expect(flag.className).toContain('border-dashed');
    await user.click(flag);
    expect(onOpenDetail).not.toHaveBeenCalled();
    expect(await screen.findByRole('dialog', { name: 'Transcript' })).toBeInTheDocument();
    expect(within(memberRow('Piet de Vries')).queryByTestId('member-left-flag')).toBeNull();
  });

  it('for a reader the flag and the role are text, and open nothing', async () => {
    mountMembers({ auth: READER });
    const flag = within(memberRow('Jan Smit')).getByTestId('member-left-flag');
    expect(flag.tagName).toBe('SPAN');
    expect(within(memberRow('Piet de Vries')).getByTestId('member-interview-role').tagName).toBe('SPAN');
  });
});

describe('Previous members', () => {
  it('who left, their role and when, the source, and what they still hold — the linked entitlements highlighted', async () => {
    mountMembers();
    const section = await screen.findByRole('region', { name: 'Previous members' });
    expect(within(section).getByRole('heading')).toHaveTextContent('Previous members (3)');
    const rows = within(section).getAllByTestId('previous-member');
    expect(rows.map(r => [...r.querySelectorAll('td')].map(td => td.textContent))).toEqual([
      ['Bram Test', 'Junior', 'former member (early years)', 'interview with Piet de Vries, 2026-10-01', '12 entitlements3 on this application'],
      ['Karel', '', 'former member', 'interview with Piet de Vries, 2026-10-01', 'not matched to an account'],
      ['Yara Weg', '', 'left', 'interview with Piet de Vries, 2026-10-01', 'noneaccount removed'],
    ]);
    expect(within(rows[0]).getByTestId('previous-member-linked').className).toContain('bg-red-50');
    // The proposed role reads dashed; the confirmed "left" plain.
    expect(within(rows[0]).getByTestId('member-interview-role').className).toContain('border-dashed');
    expect(within(rows[0]).getByText('former member (early years)').className).not.toContain('border-dashed');
    expect(within(rows[1]).getByText('former member').className).toContain('border-dashed');
  });

  it('a matched person links to their account page; a name nobody matched does not', async () => {
    const { onOpenDetail, user } = mountMembers();
    const section = await screen.findByRole('region', { name: 'Previous members' });
    await user.click(within(section).getByRole('button', { name: 'Bram Test' }));
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'p-bram', 'Bram Test');
    expect(within(section).queryByRole('button', { name: 'Karel' })).toBeNull();
  });

  it('without linked resources no "on this application"; nobody left, no section', async () => {
    mountMembers({ previous: { ...PREVIOUS, linkedResources: 0 } });
    const section = await screen.findByRole('region', { name: 'Previous members' });
    expect(within(section).queryByTestId('previous-member-linked')).toBeNull();
  });

  it('renders nothing when the interviews name nobody who left', async () => {
    const { authFetch } = mountMembers({ previous: { data: [], linkedResources: 0 } });
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/contexts/c-unit/previous-members'));
    expect(screen.queryByRole('region', { name: 'Previous members' })).toBeNull();
  });
});
