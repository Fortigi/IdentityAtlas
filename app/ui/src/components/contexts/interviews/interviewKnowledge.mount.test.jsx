// @vitest-environment jsdom
// What the product owner's test interview asked for, mounted the way the page
// uses it: What we know folded to one line, holding the unit's own facts; the
// review drawer with what matters first and the noise folded and rejectable in
// bulk; and the source text with the claims highlighted, opened from Sources or
// from a claim.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement as h } from 'react';
import ClaimsProvider from './ClaimsProvider';
import WhatWeKnow from './WhatWeKnow';
import SourcesSection from './SourcesSection';
import ReviewDrawer from './ReviewDrawer';
import { PROFILES } from '@ui/components/contexts/profiles/profiles';
import { renderWithProviders, makeAuthFetch, screen, within, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';
// Organisation knowledge is behind a flag (off by default); these tests are about it.
vi.mock('@ui/hooks/useOrgKnowledge', () => ({ useOrgKnowledge: () => true }));

const UNIT = { id: 'c-unit', displayName: 'Harbour Authority', contextCategory: 'OrganizationalUnit', targetType: 'Principal', directMemberCount: 2, extendedAttributes: { aliases: ['HA'] } };
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
const INTERVIEW = { id: 'iv-1', ...SRC, sourceKind: 'interview', extractionStatus: 'done', proposed: 5, confirmed: 1 };

function api({ claims = CLAIMS, interview = INTERVIEW } = {}) {
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
    if (u === '/api/contexts/c-unit/claims') return { data: state.claims, accountableDoubt: null, contradictions: [] };
    if (u === '/api/contexts/c-unit/interviews') return { data: [interview] };
    if (u === `/api/contexts/${interview.filedUnderId || 'c-unit'}/interviews/iv-1`) return { ...INTERVIEW, transcript: TRANSCRIPT, highlights: HIGHLIGHTS };
    if (u === '/api/contexts/c-unit/relationships') return [];
    return undefined;
  });
  return { authFetch, state };
}

const READER = { hasWildcard: false, permissions: new Set(['data.read']) };

function mount({ auth = {}, drawer = false, ...opts } = {}) {
  const { authFetch, state } = api(opts);
  renderWithProviders(h(ClaimsProvider, { contextId: 'c-unit' },
    h(WhatWeKnow, { attrs: UNIT, profile: PROFILES.OrganizationalUnit, analyst: true }),
    h(SourcesSection, { contextId: 'c-unit' }),
    drawer && h(ReviewDrawer, { onClose: () => {} })), { auth: { authFetch, ...auth } });
  return { authFetch, state, user: userEvent.setup() };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const region = () => screen.findByRole('region', { name: 'What we know' });

describe('What we know, folded', () => {
  it('starts folded to one line about the unit only — its other names, its own claims to review — and opens on click', async () => {
    const { user } = mount();
    const r = await region();
    const toggle = within(r).getByRole('button', { expanded: false });
    // Three of the five proposed claims are about the unit (canteen, weather, Port Co); the people's two are not counted.
    await waitFor(() => expect(within(r).getByTestId('what-we-know-summary')).toHaveTextContent(/^also known as HA · 3 to review$/));
    expect(within(r).queryByRole('list', { name: 'Claims to review' })).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const rows = within(within(r).getByRole('list', { name: 'Claims to review' })).getAllByTestId('claim-review-row');
    expect(rows.map(row => row.textContent.split('Quote')[0])).toEqual(['Also known asPort Co']);
    expect(r).not.toHaveTextContent('Jan Smit');
    await user.click(toggle);
    expect(within(r).queryByRole('list', { name: 'Claims to review' })).toBeNull();
  });

  it('a reader is summarised from what is confirmed, with no review count', async () => {
    mount({ auth: READER, claims: CLAIMS.filter(c => c.status === 'confirmed') });
    const r = await region();
    expect(within(r).getByTestId('what-we-know-summary')).toHaveTextContent(/^also known as HA$/);
  });
});

describe('the review drawer — what matters first', () => {
  it('lists the high tier, people and unit alike, and folds the low one under "Less relevant (2)"', async () => {
    mount({ drawer: true });
    const drawer = screen.getByRole('dialog', { name: 'To review' });
    const list = await within(drawer).findByRole('list', { name: 'Claims to review' });
    expect(within(list).getAllByTestId('claim-review-row').map(r => r.textContent.split('Quote')[0])).toEqual([
      'MembershipJan Smit — left the account (left)last month',
      'MembershipKarel — worked on it in the early years (former member)',
      'Also known asPort Co',
    ]);
    const less = within(drawer).getByTestId('less-relevant');
    expect(less).not.toHaveAttribute('open');
    expect(within(less).getByText('Less relevant (2)')).toBeInTheDocument();
    expect(within(less).getAllByTestId('claim-review-row')).toHaveLength(2);
  });

  it('"Reject all less relevant" sends one request', async () => {
    const { state, user } = mount({ drawer: true });
    await user.click(await screen.findByRole('button', { name: 'Reject all less relevant (2)' }));
    await waitFor(() => expect(screen.queryByTestId('less-relevant')).toBeNull());
    expect(state.rejects).toEqual([{ relevance: 'low' }]);
    expect(screen.queryByRole('button', { name: /Reject all descriptions/ })).toBeNull();
    expect(state.patches).toEqual([]);
  });

  it('"Reject all descriptions" counts the proposed descriptions only', async () => {
    const { state, user } = mount({ drawer: true });
    await user.click(await screen.findByRole('button', { name: 'Reject all descriptions (1)' }));
    await waitFor(() => expect(state.rejects).toEqual([{ kind: 'description' }]));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reject all less relevant (1)' })).toBeInTheDocument());
  });
});

describe('the source text', () => {
  async function openFromSources(user) {
    await user.click(await screen.findByRole('button', { name: /^Sources/ }));
    await user.click(await screen.findByRole('button', { name: 'View the interview with Piet de Vries, 2026-10-01' }));
    return screen.findByRole('dialog', { name: 'Source' });
  }

  it('opens from Sources, naming the interview and its file', async () => {
    const { user } = mount();
    const panel = await openFromSources(user);
    expect(panel).toHaveTextContent('Interview with Piet de Vries, 2026-10-01 · gesprek.vtt');
  });

  it('a source added on the parent unit is read from there', async () => {
    const { authFetch, user } = mount({ interview: { ...INTERVIEW, filedUnderId: 'c-parent', filedUnderName: 'Claims Handling' } });
    const panel = await openFromSources(user);
    await within(panel).findAllByTestId('transcript-turn');
    expect(authFetch.mock.calls.map(c => c[0])).toContain('/api/contexts/c-parent/interviews/iv-1');
    expect(authFetch.mock.calls.map(c => c[0])).not.toContain('/api/contexts/c-unit/interviews/iv-1');
  });

  it('reads as a dialogue with the quotes highlighted, a colour per kind and a fill per status, and a legend', async () => {
    const { user } = mount();
    const panel = await openFromSources(user);
    expect(panel).toHaveFocus();
    const turns = await within(panel).findAllByTestId('transcript-turn');
    expect(turns.map(t => t.firstChild.textContent)).toEqual(['Interviewer', 'Piet de Vries', '', 'Interviewer', 'Piet de Vries']);
    const legend = within(panel).getByRole('group', { name: 'Legend' });
    expect(legend).toHaveTextContent('RoleRole historyMembershipAlso known asPropertyDescriptionproposedconfirmedrejected');
    expect(legend.className).toContain('text-xs');
    const lead = within(panel).getByRole('button', { name: 'Role, confirmed: Piet de Vries — Lead (works on it)' });
    expect(lead.className).toContain('bg-blue-200');
    expect(lead.className).not.toContain('decoration-dashed');
    expect(within(panel).getByRole('button', { name: /^Description, rejected/ }).className).toContain('line-through');
    const alias = within(panel).getByRole('button', { name: 'Also known as, proposed: Port Co' });
    expect(alias.className).toContain('decoration-dashed');
    expect(alias.className).toContain('bg-teal-50');
  });

  it('a quote over two turns is highlighted in both; where two quotes overlap the piece names both claims', async () => {
    const { user } = mount();
    const panel = await openFromSources(user);
    await within(panel).findAllByTestId('transcript-turn');
    const karel = within(panel).getAllByRole('button', { name: /Karel/ });
    expect(karel.map(m => m.textContent)).toEqual(['last month', ',', 'and Karel worked on it']);
    expect(karel.map(m => m.getAttribute('data-claim-ids'))).toEqual(['m-jan m-karel', 'm-karel', 'm-karel']);
    expect(karel[0].className).toContain('bg-purple-50');
    expect(karel[0].className).toContain('outline');
  });

  it('a highlight opens its claim card, where an analyst decides it — by keyboard', async () => {
    const { state, user } = mount();
    const panel = await openFromSources(user);
    const alias = await within(panel).findByRole('button', { name: 'Also known as, proposed: Port Co' });
    alias.focus();
    await user.keyboard('{Enter}');
    const card = within(panel).getByTestId('transcript-claim-card');
    expect(card).toHaveTextContent('Also known asPort Coproposed');
    await user.click(within(card).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(state.patches).toEqual([{ id: 'a-port', body: { status: 'confirmed' } }]));
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Also known as, confirmed: Port Co' })).toBeInTheDocument());
    // A confirmed claim's card has no buttons left.
    expect(within(within(panel).getByTestId('transcript-claim-card')).queryByRole('button')).toBeNull();
  });

  it('"In transcript" in the review opens the panel at the quote and makes it pulse; Escape closes it', async () => {
    const { user } = mount({ drawer: true });
    const list = await within(screen.getByRole('dialog', { name: 'To review' })).findByRole('list', { name: 'Claims to review' });
    await user.click(within(list).getByRole('button', { name: 'Show “Jan Smit just left the account last month” in the transcript' }));
    const panel = await screen.findByRole('dialog', { name: 'Source' });
    const [jan] = await within(panel).findAllByRole('button', { name: /^Membership, proposed: Jan Smit/ });
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    expect(Element.prototype.scrollIntoView.mock.contexts[0]).toBe(jan);
    await waitFor(() => expect(jan.className).toContain('animate-pulse'));
    expect(within(panel).getByTestId('transcript-claim-card')).toHaveTextContent('Jan Smit — left the account (left)');
    await user.click(within(panel).getByRole('button', { name: 'Close the source' }));
    expect(screen.queryByRole('dialog', { name: 'Source' })).toBeNull();
  });

  it('a reader sees no sources and no way to open a text', async () => {
    const { authFetch } = mount({ auth: READER, claims: CLAIMS.filter(c => c.status === 'confirmed') });
    await region();
    expect(screen.queryByRole('region', { name: 'Sources' })).toBeNull();
    expect(authFetch.mock.calls.map(c => c[0])).not.toContain('/api/contexts/c-unit/interviews/iv-1');
  });
});
