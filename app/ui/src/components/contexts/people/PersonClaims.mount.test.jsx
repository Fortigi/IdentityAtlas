// @vitest-environment jsdom
// What the sources say about one person, as icons on their row of the People
// overview: an icon per kind of claim (dashed while proposed, solid confirmed),
// a popover on hover or focus with the claim in one line, the quote cut at 200
// characters, the source and the status; Confirm / Reject and the source text
// for an analyst; a warning icon for an open contradiction with both statements
// and the decision; Undo on the claim a decision rests on. Invented names.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement as h } from 'react';
import ClaimsProvider from '@ui/components/contexts/interviews/ClaimsProvider';
import PersonClaims from './PersonClaims';
import { renderWithProviders, makeAuthFetch, screen, within, waitFor, userEvent, act } from '@ui/test-utils/renderWithProviders';

const SRC = { interviewId: 'iv-1', intervieweeName: 'Iris Interviewee', interviewedAt: '2026-10-01', sourceKind: 'interview', fileName: 'talk.vtt' };
const LONG = `Joris started as a junior here ${'and then did many other things '.repeat(8)}and is back now.`;
const ROLE = { id: 'r-joris', claimKind: 'role', attribute: 'member', value: 'architect', status: 'proposed', quote: LONG, ...SRC };
const HIST = { id: 'h-joris', claimKind: 'roleHistory', attribute: 'member', value: 'junior developer', status: 'confirmed', periodText: 'early years', quote: 'Joris started as a junior', ...SRC };
const GONE = { id: 'm-bob', claimKind: 'membership', attribute: 'left', value: 'left the team', status: 'confirmed', quote: 'Bob left the team', ...SRC };
const PRESENT = { id: 'm-dana', claimKind: 'membership', attribute: 'current', value: 'is in it', status: 'proposed', quote: 'Dana is in the team', ...SRC };

const JORIS = { key: 'p:joris', displayName: 'Joris Jansen', claims: [ROLE, HIST], contradictions: [] };
const BOB = { key: 'p:bob', displayName: 'Bob Sample', claims: [GONE], contradictions: [], decision: { claimId: 'm-bob', overrides: 'Customer list' } };
const DANA = { key: 'i:dana', displayName: 'Dana Said', claims: [PRESENT], contradictions: ['memberNotListed:m-dana'] };
const CONTRADICTION = {
  id: 'memberNotListed:m-dana', rule: 'memberNotListed', status: 'open', claimIds: ['m-dana'],
  claim: { kind: 'claim', statement: 'Interview: Dana Said is a member', claim: { ...PRESENT, subjectName: 'Dana Said' } },
  other: { kind: 'fact', statement: 'Customer list does not list Dana Said', source: 'Customer list (upload), last synced 2026-10-20' },
};

function mount(person, { auth = {}, undoFails = false } = {}) {
  const calls = [];
  const authFetch = makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    if (opts.method) calls.push([opts.method, u, opts.body ? JSON.parse(opts.body) : null]);
    if (opts.method === 'PATCH') return { claim: {}, effect: { kind: 'none' } };
    if (u.endsWith('/undo')) return undoFails ? { ok: false, status: 409, json: async () => ({ error: 'This claim has not been decided' }) } : { claim: {} };
    if (u === '/api/contexts/c-unit/claims') return { data: [ROLE, HIST, GONE, PRESENT], contradictions: [CONTRADICTION], accountableDoubt: null };
    if (u === '/api/contexts/c-unit/interviews') return { data: [] };
    if (u === '/api/contexts/c-unit/interviews/iv-1') return { id: 'iv-1', ...SRC, transcript: LONG, highlights: [] };
    return undefined;
  });
  renderWithProviders(h(ClaimsProvider, { contextId: 'c-unit' }, h(PersonClaims, { person })), { auth: { authFetch, ...auth } });
  return { calls, authFetch, user: userEvent.setup() };
}

const READER = { hasWildcard: false, permissions: new Set(['data.read']) };
const popoverOf = (icon) => document.getElementById(icon.getAttribute('aria-describedby'));

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });

describe('the icons', () => {
  it('one per kind of claim, dashed while proposed and solid once confirmed, each named for a screen reader', async () => {
    mount(JORIS);
    const role = await screen.findByTestId('person-claim-role');
    const history = screen.getByTestId('person-claim-history');
    expect([role.dataset.variant, history.dataset.variant]).toEqual(['proposed', 'confirmed']);
    expect(role).toHaveAccessibleName('Role — architect (works on it) (to review)');
    expect(history).toHaveAccessibleName('History — junior developer (confirmed)');
    expect(screen.queryByTestId('person-claim-membership')).toBeNull();
  });

  it('nothing for a person no source says anything about', () => {
    const { container } = renderWithProviders(h(PersonClaims, { person: { displayName: 'Quiet', claims: [], contradictions: [] } }));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('the popover', () => {
  it('is hidden until the icon is hovered; says the claim, the quote cut at 200 characters, the source and the status', async () => {
    const { user } = mount(JORIS);
    const role = await screen.findByTestId('person-claim-role');
    const pop = popoverOf(role);
    expect(pop).not.toBeVisible();
    await user.hover(role);
    expect(pop).toBeVisible();
    const [line] = within(pop).getAllByTestId('person-claim');
    expect(within(line).getByText(/^architect/)).toHaveTextContent('architect (works on it)');
    const quote = line.querySelector('blockquote').textContent;
    expect(quote).toBe(`“${LONG.slice(0, 199).trimEnd()}…”`);
    expect(quote.length).toBeLessThanOrEqual(202);
    expect(line).toHaveTextContent('interview with Iris Interviewee, 2026-10-01 · proposed');
    await user.unhover(role);
    expect(pop).not.toBeVisible();
  });

  it('opens on focus too; Escape closes it and leaves the focus on the icon', async () => {
    const { user } = mount(JORIS);
    const history = await screen.findByTestId('person-claim-history');
    act(() => history.focus());
    expect(popoverOf(history)).toBeVisible();
    expect(history).toHaveAttribute('aria-expanded', 'true');
    expect(popoverOf(history)).toHaveTextContent('junior developer · early years');
    await user.keyboard('{Escape}');
    expect(popoverOf(history)).not.toBeVisible();
    expect(history).toHaveFocus();
  });

  it('Confirm and Reject decide the claim, for an analyst', async () => {
    const { calls, user } = mount(JORIS);
    const role = await screen.findByTestId('person-claim-role');
    await user.hover(role);
    await user.click(within(popoverOf(role)).getByRole('button', { name: 'Confirm: architect (works on it)' }));
    await waitFor(() => expect(calls).toContainEqual(['PATCH', '/api/contexts/claims/r-joris', { status: 'confirmed' }]));
    await user.click(within(popoverOf(role)).getByRole('button', { name: 'Reject: architect (works on it)' }));
    await waitFor(() => expect(calls).toContainEqual(['PATCH', '/api/contexts/claims/r-joris', { status: 'rejected' }]));
    // A confirmed claim has nothing to decide.
    expect(within(popoverOf(screen.getByTestId('person-claim-history'))).queryByRole('button', { name: /^Confirm/ })).toBeNull();
  });

  it('a click on the icon opens the source text at that claim', async () => {
    const { authFetch, user } = mount(JORIS);
    await user.click(await screen.findByTestId('person-claim-history'));
    expect(await screen.findByRole('dialog', { name: 'Source' })).toHaveTextContent('Interview with Iris Interviewee, 2026-10-01 · talk.vtt');
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/c-unit/interviews/iv-1');
  });

  it('a reader sees the confirmed words without buttons; a click pins the popover open', async () => {
    const { authFetch, user } = mount(JORIS, { auth: READER });
    const history = await screen.findByTestId('person-claim-history');
    await user.click(history);
    await user.unhover(history);
    const pop = popoverOf(history);
    expect(pop).toBeVisible();
    expect(within(pop).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Source' })).toBeNull();
    expect(authFetch.mock.calls.map(c => c[0])).not.toContain('/api/contexts/c-unit/interviews');
  });
});

describe('an open contradiction on the row', () => {
  it('a warning icon whose popover holds both statements, each with its source, and the decision', async () => {
    const { calls, user } = mount(DANA);
    const warning = await screen.findByTestId('person-contradiction');
    expect(warning.dataset.variant).toBe('warning');
    expect(warning).toHaveAccessibleName('To decide for Dana Said: A member, but not listed');
    await user.hover(warning);
    const pop = popoverOf(warning);
    expect(within(pop).getByTestId('contradiction-claim')).toHaveTextContent('Interview: Dana Said is a member');
    expect(within(pop).getByTestId('contradiction-claim')).toHaveTextContent('Dana is in the team');
    expect(within(pop).getByTestId('contradiction-other')).toHaveTextContent('Customer list does not list Dana SaidSource: Customer list (upload), last synced 2026-10-20');
    await user.click(within(pop).getByRole('button', { name: 'The interview is right' }));
    await waitFor(() => expect(calls).toEqual([['PATCH', '/api/contexts/claims/m-dana', { status: 'confirmed' }]]));
  });

  it('a reader sees the two statements, and that an analyst decides', async () => {
    const { user } = mount(DANA, { auth: READER });
    const warning = await screen.findByTestId('person-contradiction');
    await user.hover(warning);
    expect(popoverOf(warning)).toHaveTextContent('An analyst decides which is right.');
    expect(within(popoverOf(warning)).queryByRole('button', { name: /right/ })).toBeNull();
  });
});

describe('undoing the decision a person was marked former on', () => {
  it('Undo decision on that claim reopens it', async () => {
    const { calls, user } = mount(BOB);
    const icon = await screen.findByTestId('person-claim-membership');
    await user.hover(icon);
    await user.click(within(popoverOf(icon)).getByRole('button', { name: 'Undo decision' }));
    await waitFor(() => expect(calls).toContainEqual(['POST', '/api/contexts/claims/m-bob/undo', {}]));
  });

  it('an undo the API refuses says why', async () => {
    const { user } = mount(BOB, { undoFails: true });
    const icon = await screen.findByTestId('person-claim-membership');
    await user.hover(icon);
    await user.click(within(popoverOf(icon)).getByRole('button', { name: 'Undo decision' }));
    expect(await within(popoverOf(icon)).findByRole('alert')).toHaveTextContent('This claim has not been decided');
  });

  it('a reader has no Undo', async () => {
    const { user } = mount(BOB, { auth: READER });
    const icon = await screen.findByTestId('person-claim-membership');
    await user.hover(icon);
    expect(within(popoverOf(icon)).queryByRole('button', { name: 'Undo decision' })).toBeNull();
  });
});
