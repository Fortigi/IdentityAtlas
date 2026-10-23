// @vitest-environment jsdom
// Contradictions: a claim against the fact it disagrees with, side by side with
// their sources, and an explicit choice that decides the claim(s). Invented names.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement as h } from 'react';
import ContextProfile from '@ui/components/contexts/profiles/ContextProfile';
import { PROFILES } from '@ui/components/contexts/profiles/profiles';
import { decisionsFor, withPeriod, openContradictions, contradictionCount, panelId } from './contradiction.helpers';
import { ContradictionsBadge } from './Contradictions';
import ClaimsProvider from './ClaimsProvider';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, within, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const READER = { hasWildcard: false, permissions: new Set(['data.read']) };
const UNIT = { id: 'c-unit', displayName: 'Harbour Office', contextCategory: 'OrganizationalUnit', targetType: 'Principal', directMemberCount: 3 };
const SRC = { interviewId: 'iv-1', intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01' };

const sideClaim = (id, statement, over = {}) => ({ kind: 'claim', statement, claim: { id, status: 'proposed', subjectName: 'Lotte Lindeboom', quote: `quote of ${id}`, ...SRC, ...over } });
const LEFT = {
  id: 'leftButMember:m-lotte', rule: 'leftButMember', status: 'open', claimIds: ['m-lotte'],
  claim: sideClaim('m-lotte', 'Interview: Lotte Lindeboom is a former member', { quote: 'Lotte deed dat ook, maar is recent uitgestroomd.' }),
  other: { kind: 'fact', statement: 'HR export (upload) still lists Lotte Lindeboom as a member', source: 'HR export (upload), last synced 2026-10-20' },
};
const OWNER = {
  id: 'accountable:r-piet', rule: 'accountable', status: 'open', claimIds: ['r-piet'],
  claim: sideClaim('r-piet', 'Interview: Piet Proef is the owner', { subjectName: 'Piet Proef' }),
  other: { kind: 'fact', statement: 'Yara Ypma is the Accountable', source: 'Yara Ypma, from the source' },
};
const PAIR = {
  id: 'claims:m-a+m-b', rule: 'claims', status: 'open', claimIds: ['m-a', 'm-b'],
  claim: sideClaim('m-a', 'Interview: Jan Smit left'), other: sideClaim('m-b', 'Interview: Jan Smit is a member', { intervieweeName: 'Bram Bakker', interviewedAt: '2026-10-05', interviewId: 'iv-2' }),
};
const DECIDED = { ...LEFT, id: 'leftButMember:old', status: 'decided', resolution: 'source' };

describe('contradiction.helpers', () => {
  it('the choices of each rule, as claim decisions', () => {
    expect(decisionsFor(LEFT).map(c => [c.key, c.label, c.steps.map(s => [s.claimId, s.body])])).toEqual([
      ['interview', 'The interview is right — mark as former', [['m-lotte', { status: 'confirmed' }]]],
      ['source', 'The list is right', [['m-lotte', { status: 'rejected' }]]],
      ['both', 'Both true, at different times', [['m-lotte', { status: 'edited' }]]],
    ]);
    expect(decisionsFor(LEFT)[0].hint).toBe('Marks them former here and lists them under Previous members; HR export (upload) still lists them — remove them there, or re-import without them. Undo is possible.');
    expect(decisionsFor(OWNER).map(c => [c.label, c.steps[0].body])).toEqual([
      ['The interview is right — make Piet Proef the Accountable', { status: 'confirmed', replace: true }],
      ['Keep Yara Ypma', { status: 'rejected' }],
    ]);
    expect(decisionsFor({ ...OWNER, rule: 'notOwner' }).map(c => c.label)).toEqual(['The interview is right', 'Keep Yara Ypma as the Accountable']);
    expect(decisionsFor({ ...LEFT, rule: 'memberNotListed' }).map(c => c.key)).toEqual(['interview', 'source', 'both']);
    expect(decisionsFor({ ...LEFT, rule: 'property', other: { kind: 'fact', statement: 'sector is Shipping' } }).map(c => c.label)).toEqual(['The interview is right — set it', 'Keep “sector is Shipping”']);
  });

  it('a pair: keep one (confirm it, reject the other), or both; claims already decided are left alone', () => {
    const steps = (con, key) => decisionsFor(con).find(c => c.key === key).steps.map(s => [s.claimId, s.body.status]);
    expect(steps(PAIR, 'first')).toEqual([['m-a', 'confirmed'], ['m-b', 'rejected']]);
    expect(steps(PAIR, 'second')).toEqual([['m-b', 'confirmed'], ['m-a', 'rejected']]);
    expect(steps(PAIR, 'both')).toEqual([['m-a', 'confirmed'], ['m-b', 'confirmed']]);
    const half = { ...PAIR, claim: sideClaim('m-a', 'x', { status: 'confirmed' }) };
    expect(steps(half, 'first')).toEqual([['m-b', 'rejected']]);
  });

  it('nothing to choose for a decided one, an unknown rule or a claim already decided', () => {
    expect(decisionsFor(DECIDED)).toEqual([]);
    expect(decisionsFor(null)).toEqual([]);
    expect(decisionsFor({ ...LEFT, rule: 'other' })).toEqual([]);
    expect(decisionsFor({ ...LEFT, claim: sideClaim('m', 'x', { status: 'confirmed' }) })).toEqual([]);
  });

  it('the period goes into a "both" step; other choices are sent as they are', () => {
    const both = decisionsFor(LEFT)[2];
    expect(withPeriod(both, ' until 2025 ')).toEqual([expect.objectContaining({ body: { status: 'edited', periodText: 'until 2025' } })]);
    expect(withPeriod(decisionsFor(LEFT)[0], 'x')[0].body).toEqual({ status: 'confirmed' });
    expect(openContradictions([LEFT, DECIDED])).toEqual([LEFT]);
    expect(openContradictions(undefined)).toEqual([]);
    expect([contradictionCount(1), contradictionCount(2)]).toEqual(['1 contradiction', '2 contradictions']);
    expect(panelId('c-unit')).toBe('contradictions-c-unit');
  });
});

function api(contradictions = [LEFT, OWNER, PAIR, DECIDED]) {
  const state = { patches: [], contradictions: contradictions.map(c => ({ ...c })) };
  const authFetch = makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    const patch = /^\/api\/contexts\/claims\/([^/]+)$/.exec(u);
    if (patch && opts.method === 'PATCH') {
      const body = JSON.parse(opts.body);
      state.patches.push([patch[1], body]);
      state.contradictions = state.contradictions.map(c => (c.claimIds.includes(patch[1]) ? { ...c, status: 'decided' } : c));
      return { claim: { id: patch[1] }, effect: { kind: 'none' } };
    }
    if (u === '/api/contexts/c-unit/claims') return { data: [], accountableDoubt: null, contradictions: state.contradictions };
    if (u === '/api/contexts/c-unit/interviews') return { data: [] };
    if (u === '/api/contexts/c-unit/roles/suggestion') return jsonResponse(undefined, { status: 204 });
    if (u === '/api/contexts/c-unit/roles') return [];
    if (u === '/api/contexts/c-unit/relationships') return [];
    return undefined;
  });
  return { authFetch, state };
}

function mount({ auth = {}, contradictions } = {}) {
  window.sessionStorage.clear();
  const { authFetch, state } = api(contradictions);
  renderWithProviders(h(ContextProfile, { profile: PROFILES.OrganizationalUnit, attrs: UNIT }), { auth: { authFetch, ...auth } });
  return { state, user: userEvent.setup() };
}

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });

const panel = () => screen.findByRole('region', { name: 'Contradictions' });
const item = async (statement) => (await screen.findAllByTestId('contradiction')).find(li => li.textContent.includes(statement));

describe('the Contradictions panel', () => {
  it('at the top of What we know, even folded: the open ones only, each as two statements with their sources', async () => {
    mount();
    const p = await panel();
    expect(within(p).getByRole('heading')).toHaveTextContent('Contradictions (3)');
    expect(within(p).getAllByTestId('contradiction')).toHaveLength(3);
    const left = await item('Lotte');
    expect(within(left).getByTestId('contradiction-claim')).toHaveTextContent('Interview: Lotte Lindeboom is a former member');
    expect(within(left).getByTestId('contradiction-claim')).toHaveTextContent('interview with Anna Voorbeeld, 2026-10-01');
    expect(within(left).getByTestId('contradiction-claim')).toHaveTextContent('Lotte deed dat ook, maar is recent uitgestroomd.');
    expect(within(left).getByTestId('contradiction-other')).toHaveTextContent('HR export (upload) still lists Lotte Lindeboom as a member');
    expect(within(left).getByTestId('contradiction-other')).toHaveTextContent('Source: HR export (upload), last synced 2026-10-20');
    const pair = await item('Jan Smit left');
    expect(within(pair).getByTestId('contradiction-other')).toHaveTextContent('interview with Bram Bakker, 2026-10-05');
  });

  it('"View in transcript" opens the claim\'s interview', async () => {
    const { user } = mount();
    await user.click(within(await item('Lotte')).getAllByRole('button', { name: 'View in transcript' })[0]);
    expect(await screen.findByRole('dialog', { name: 'Transcript' })).toBeInTheDocument();
  });

  it('"The interview is right" confirms the claim, and the decided one leaves the panel', async () => {
    const { state, user } = mount();
    await user.click(within(await item('Lotte')).getByRole('button', { name: 'The interview is right — mark as former' }));
    expect(state.patches).toEqual([['m-lotte', { status: 'confirmed' }]]);
    await waitFor(() => expect(screen.getAllByTestId('contradiction')).toHaveLength(2));
  });

  it('"The list is right" rejects it', async () => {
    const { state, user } = mount();
    await user.click(within(await item('Lotte')).getByRole('button', { name: 'The list is right' }));
    expect(state.patches).toEqual([['m-lotte', { status: 'rejected' }]]);
  });

  it('"Both true, at different times" asks when, then saves the claim with that period', async () => {
    const { state, user } = mount();
    const left = await item('Lotte');
    await user.click(within(left).getByRole('button', { name: 'Both true, at different times' }));
    expect(state.patches).toEqual([]);
    const save = within(left).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.type(within(left).getByRole('textbox', { name: 'When was the interview\'s statement true?' }), 'until 2025');
    await user.click(save);
    expect(state.patches).toEqual([['m-lotte', { status: 'edited', periodText: 'until 2025' }]]);
  });

  it('another owner: the interview is right replaces the Accountable in one go', async () => {
    const { state, user } = mount();
    await user.click(within(await item('Piet Proef')).getByRole('button', { name: 'The interview is right — make Piet Proef the Accountable' }));
    expect(state.patches).toEqual([['r-piet', { status: 'confirmed', replace: true }]]);
  });

  it('two claims: keeping the first confirms it and rejects the second', async () => {
    const { state, user } = mount();
    await user.click(within(await item('Jan Smit left')).getByRole('button', { name: 'The first is right' }));
    await waitFor(() => expect(state.patches).toEqual([['m-a', { status: 'confirmed' }], ['m-b', { status: 'rejected' }]]));
  });

  it('a reader sees the pairs, without a choice or a transcript', async () => {
    mount({ auth: READER });
    const p = await panel();
    expect(within(p).getAllByTestId('contradiction')).toHaveLength(3);
    expect(within(p).queryByRole('button')).toBeNull();
    expect(p).toHaveTextContent('An analyst decides which is right.');
  });

  it('nothing open, no panel', async () => {
    const { state } = mount({ contradictions: [DECIDED] });
    await waitFor(() => expect(state.patches).toEqual([]));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Contradictions' })).toBeNull());
  });
});

describe('the badge', () => {
  it('"3 contradictions to decide" jumps to the panel; nothing without open ones', async () => {
    const { authFetch } = api();
    renderWithProviders(h(ClaimsProvider, { contextId: 'c-unit' },
      h('div', null, h(ContradictionsBadge), h('section', { id: panelId('c-unit') }))), { auth: { authFetch } });
    const badge = await screen.findByTestId('contradictions-badge');
    expect(badge).toHaveTextContent('3 contradictions to decide');
    await userEvent.setup().click(badge);
    expect(document.getElementById('contradictions-c-unit').scrollIntoView).toHaveBeenCalled();
  });
});
