// @vitest-environment jsdom
// Context interviews on a context's page, mounted the way the detail page puts
// them together inside one ClaimsProvider: the people block's suggestions from a
// source, "What we know" (the unit's own facts and its review), the review
// drawer (every proposed claim), and Sources — and what a reader sees instead.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement as h, useState } from 'react';
import ClaimsProvider, { POLL_MS } from './ClaimsProvider';
import WhatWeKnow from './WhatWeKnow';
import SourcesSection from './SourcesSection';
import ReviewDrawer from './ReviewDrawer';
import ContextPeople from '@ui/components/contexts/ContextPeople';
import { PROFILES } from '@ui/components/contexts/profiles/profiles';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, within, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const APP = { id: 'c-app', displayName: 'Planner', contextCategory: 'LogicalApplication', targetType: 'Resource', directMemberCount: 3, description: 'Schedules the nursing shifts' };
const SRC = { intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01', fileName: 'gesprek.vtt', proposedBy: 'model' };

const ACCOUNTABLE = { id: 'cl-own', claimKind: 'role', status: 'proposed', principalId: 'p-anna', subjectName: 'interviewee', subjectDisplayName: 'Anna Voorbeeld', subjectMatch: 'interviewee', attribute: 'owner', value: 'owner of the planner', roleSuggestion: 'Accountable', quote: 'Yes, I am the owner of this app', ...SRC };
const RESPONSIBLE = { id: 'cl-piet', claimKind: 'role', status: 'proposed', principalId: 'p-piet', subjectName: 'Piet', subjectDisplayName: 'Piet Proefpersoon', subjectMatch: 'firstName', attribute: 'dayToDay', value: 'does the day-to-day', roleSuggestion: 'Responsible', quote: 'it is mostly Piet who does the day-to-day', ...SRC };
const UNMATCHED = { id: 'cl-karel', claimKind: 'role', status: 'proposed', subjectName: 'Karel', attribute: 'delegate', value: 'backup', roleSuggestion: 'Responsible', quote: 'Karel is my backup', ...SRC };
const PROPERTY = { id: 'cl-users', claimKind: 'property', status: 'proposed', attribute: 'users', value: 'about 400 nurses', quote: 'about 400 nurses', ...SRC };
const CONFIRMED = [
  { id: 'k-vendor', claimKind: 'property', status: 'edited', attribute: 'vendor', value: 'Example Software', quote: 'bought from Example Software', ...SRC },
  { id: 'k-h1', claimKind: 'roleHistory', status: 'confirmed', principalId: 'p-bram', subjectDisplayName: 'Bram Test', value: 'junior', periodText: 'early years', ...SRC },
];
const INTERVIEW = { id: 'iv-1', ...SRC, sourceKind: 'interview', extractionStatus: 'done', extractionMessage: '1 claim was left out because the quote is not in the transcript.', proposed: 4, confirmed: 2 };

// A PATCH of one claim: record it, answer the first Accountable confirmation with
// a 409 when asked to, otherwise decide the claim and add the role it becomes.
function patchClaim(state, conflictOnce, id, opts) {
  const body = JSON.parse(opts.body);
  state.patches.push({ id, body });
  if (conflictOnce && !state.conflicted && body.status === 'confirmed' && id === 'cl-own') {
    state.conflicted = true;
    return jsonResponse({ error: 'This context already has an Accountable', details: { current: { id: 'r-0', displayName: 'Old Owner', principalId: 'p-old' } } }, { ok: false, status: 409 });
  }
  const c = state.claims.find(x => x.id === id);
  c.status = body.status === 'rejected' ? 'rejected' : 'confirmed';
  if (body.value) { c.value = body.value; c.status = 'edited'; }
  if (c.status !== 'rejected' && c.roleSuggestion) state.roles.push({ id: `r-${c.id}`, role: c.roleSuggestion, principalId: body.principalId || c.principalId, displayName: body.principalId ? 'Karel Kiezer' : c.subjectDisplayName, addedBy: 'analyst', sourceClaimId: c.id, sourceIntervieweeName: 'Anna Voorbeeld', sourceInterviewedAt: '2026-10-01' });
  return { claim: c, effect: { kind: 'none' } };
}

function getRoutes(state, doubt) {
  return new Map(Object.entries({
    '/api/contexts/c-app/claims': () => ({ data: state.claims, accountableDoubt: doubt, contradictions: [] }),
    '/api/contexts/c-app/interviews': () => ({ data: state.interviews }),
    '/api/contexts/c-app/interviews/iv-1/extract': () => jsonResponse({ id: 'iv-1', extractionStatus: 'pending' }, { status: 202 }),
    '/api/contexts/c-app/roles/suggestion': () => jsonResponse(undefined, { status: 204 }),
    '/api/contexts/c-app/roles': () => state.roles,
    '/api/contexts/c-app/relationships': () => [],
  }));
}

// A stateful API: the claims and roles change as the page decides them.
function api({ claims = [ACCOUNTABLE, RESPONSIBLE, UNMATCHED, PROPERTY, ...CONFIRMED], roles = [], interviews = [INTERVIEW], conflictOnce = false, doubt = null } = {}) {
  const state = { claims: claims.map(c => ({ ...c })), roles: [...roles], patches: [], conflicted: false, interviews };
  const routes = getRoutes(state, doubt);
  const authFetch = makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    const patch = /^\/api\/contexts\/claims\/([^/]+)$/.exec(u);
    if (patch && opts.method === 'PATCH') return patchClaim(state, conflictOnce, patch[1], opts);
    if (routes.has(u)) return routes.get(u)();
    if (u.startsWith('/api/users?search=kar')) return { data: [{ id: 'p-karel', displayName: 'Karel Kiezer' }] };
    if (u.startsWith('/api/users?')) return { data: [] };
    return undefined;
  });
  return { authFetch, state };
}

// The sections as the page has them, What we know and Sources open.
function Page() {
  const [know, setKnow] = useState(true);
  const [sources, setSources] = useState(true);
  const [reviewing, setReviewing] = useState(false);
  const profile = PROFILES.LogicalApplication;
  return h(ClaimsProvider, { contextId: APP.id },
    h(ContextPeople, { attrs: APP, heading: null, accountableLabel: profile.accountableLabel, noun: profile.noun, suggest: true }),
    h(WhatWeKnow, { attrs: APP, profile, analyst: true, open: know, onOpenChange: setKnow }),
    h(SourcesSection, { contextId: APP.id, open: sources, onOpenChange: setSources }),
    h('button', { type: 'button', onClick: () => setReviewing(true) }, 'review all'),
    reviewing && h(ReviewDrawer, { onClose: () => setReviewing(false) }));
}

function mount({ auth = {}, ...opts } = {}) {
  const { authFetch, state } = api(opts);
  renderWithProviders(h(Page), { auth: { authFetch, ...auth } });
  return { authFetch, state, user: userEvent.setup() };
}

const READER = { hasWildcard: false, permissions: new Set(['data.read']) };
const group = (name) => screen.getByRole('group', { name: new RegExp(`^${name}`) });
const whatWeKnow = () => screen.getByRole('region', { name: 'What we know' });

describe('the people block — suggestions from a source', () => {
  it('shows the owner under Owner and the day-to-day person under Responsible, each with the quote and the interview', async () => {
    mount();
    const owner = await within(group('Owner')).findByTestId('interview-suggestion');
    expect(owner).toHaveTextContent(/^Suggested: Anna Voorbeeld· “Yes, I am the owner of this app” \(interview with Anna Voorbeeld, 2026-10-01\)ConfirmNot this personChoose someone else$/);
    const responsible = within(group('Responsible')).getAllByTestId('interview-suggestion');
    expect(responsible.map(r => r.textContent.split('·')[0])).toEqual(['Suggested: Piet Proefpersoon', 'Suggested: Karel']);
    expect(responsible[0]).toHaveTextContent('check the person');
    expect(owner).not.toHaveTextContent('check the person');
  });

  it('Confirm confirms the claim and the role appears, naming the interview it came from', async () => {
    const { state, user } = mount();
    const row = await within(group('Responsible')).findAllByTestId('interview-suggestion');
    await user.click(within(row[0]).getByRole('button', { name: 'Confirm' }));
    expect(state.patches).toEqual([{ id: 'cl-piet', body: { status: 'confirmed' } }]);
    await waitFor(() => expect(group('Responsible')).toHaveTextContent('Piet Proefpersoonfrom the interview with Anna Voorbeeld, 2026-10-01'));
    expect(within(group('Responsible')).getAllByTestId('interview-suggestion')).toHaveLength(1);
  });

  it('an Accountable already set: asks before replacing, and replaces only on yes', async () => {
    const { state, user } = mount({ conflictOnce: true });
    const row = await within(group('Owner')).findByTestId('interview-suggestion');
    await user.click(within(row).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Old Owner is the Accountable now. Replace them with Anna Voorbeeld?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(state.patches).toHaveLength(2));
    expect(state.patches[1]).toEqual({ id: 'cl-own', body: { status: 'confirmed', replace: true } });
  });

  it('declining the replacement sends nothing more', async () => {
    const { state, user } = mount({ conflictOnce: true });
    await user.click(within(await within(group('Owner')).findByTestId('interview-suggestion')).getByRole('button', { name: 'Confirm' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(state.patches).toHaveLength(1);
    expect(within(group('Owner')).getByTestId('interview-suggestion')).toBeInTheDocument();
  });

  it('shows a doubt about the current Accountable under it', async () => {
    mount({ roles: [{ id: 'r-1', role: 'Accountable', principalId: 'p-anna', displayName: 'Anna Voorbeeld', addedBy: 'analyst' }],
      doubt: { claimId: 'c-x', quote: 'I am not really the owner', intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01' } });
    expect(await within(group('Owner')).findByTestId('accountable-doubt')).toHaveTextContent('In doubt: “I am not really the owner” (interview with Anna Voorbeeld, 2026-10-01)');
  });
});

describe('What we know — the unit itself', () => {
  it('holds the description and the properties with their source; nothing about people', async () => {
    mount();
    const region = await screen.findByRole('region', { name: 'What we know' });
    await waitFor(() => expect(within(region).getByText('vendor').nextElementSibling).toHaveTextContent(/^Example Software/));
    expect(within(region).getByText('Schedules the nursing shifts')).toBeInTheDocument();
    expect(region).not.toHaveTextContent('Bram Test');
    expect(region).not.toHaveTextContent('junior');
    expect(within(region).getByText('interview with Anna Voorbeeld, 2026-10-01')).toBeInTheDocument();
  });

  it('reviews only the unit\'s own claims; Edit changes the value and confirms it', async () => {
    const { state, user } = mount();
    const list = await within(whatWeKnow()).findByRole('list', { name: 'Claims to review' });
    const rows = within(list).getAllByTestId('claim-review-row');
    expect(rows.map(r => r.textContent.split('Quote')[0])).toEqual(['Propertyusers: about 400 nurses']);
    await user.click(within(rows[0]).getByRole('button', { name: 'Edit' }));
    const value = within(rows[0]).getByRole('textbox', { name: 'Value' });
    await user.clear(value);
    await user.type(value, 'about 450 nurses');
    await user.click(within(rows[0]).getByRole('button', { name: 'Save and confirm' }));
    await waitFor(() => expect(state.patches).toEqual([{ id: 'cl-users', body: { status: 'edited', value: 'about 450 nurses', periodText: null } }]));
    await waitFor(() => expect(within(whatWeKnow()).getByText('users').nextElementSibling).toHaveTextContent(/^about 450 nurses/));
  });
});

describe('the review drawer — every proposed claim', () => {
  it('lists the people\'s claims too; a role claim with nobody matched asks who was meant before it confirms', async () => {
    const { state, user } = mount();
    await user.click(screen.getByRole('button', { name: 'review all' }));
    const drawer = await screen.findByRole('dialog', { name: 'To review' });
    const rows = within(drawer).getAllByTestId('claim-review-row');
    expect(rows).toHaveLength(4);
    const karel = rows.find(r => r.textContent.includes('Karel'));
    expect(within(karel).queryByRole('button', { name: 'Confirm' })).toBeNull();
    await user.click(within(karel).getByRole('button', { name: 'Choose who and confirm' }));
    await user.type(screen.getByRole('textbox', { name: 'Find the person who was meant' }), 'kar');
    await user.click(await screen.findByRole('button', { name: 'Karel Kiezer' }));
    await waitFor(() => expect(state.patches).toEqual([{ id: 'cl-karel', body: { status: 'confirmed', principalId: 'p-karel' } }]));
  });

  it('Escape closes it; with nothing to review it says so', async () => {
    const { user } = mount({ claims: CONFIRMED });
    await user.click(screen.getByRole('button', { name: 'review all' }));
    expect(await screen.findByText('Nothing left to review.')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'To review' })).toBeNull();
  });
});

describe('Sources', () => {
  it('folds to how many and the latest date; lists the run, reads it again, Add information sits on its line', async () => {
    const { authFetch, user } = mount();
    expect(await screen.findByTestId('sources-summary')).toHaveTextContent('1 source · latest 2026-10-01');
    const sources = await screen.findByRole('list', { name: 'Sources' });
    expect(sources).toHaveTextContent('InterviewAnna Voorbeeld · 2026-10-01 · gesprek.vttRead4 to review · 2 confirmed');
    await user.click(within(sources).getByRole('button', { name: 'Read again' }));
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/c-app/interviews/iv-1/extract', { method: 'POST' });
    expect(within(screen.getByRole('region', { name: 'Sources' })).getByRole('button', { name: 'Add information' })).toBeInTheDocument();
  });
});

describe('while a source is being read', () => {
  afterEach(() => vi.useRealTimers());

  it('reads the sources and claims again every few seconds, and stops once none is in progress', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { authFetch, state } = mount({ interviews: [{ ...INTERVIEW, extractionStatus: 'running' }] });
    const calls = () => authFetch.mock.calls.filter(c => c[0] === '/api/contexts/c-app/interviews').length;
    await waitFor(() => expect(calls()).toBe(1));
    state.interviews = [INTERVIEW];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await waitFor(() => expect(calls()).toBe(2));
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(calls()).toBe(2);
  });

  it('a run that goes on says how long, and that the model may be busy', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));
    mount({ interviews: [{ ...INTERVIEW, extractionStatus: 'running', extractionStartedAt: '2026-10-23T11:59:00Z' }] });
    expect(await screen.findByTestId('extraction-status')).toHaveTextContent(/^Reading…$/);
    await vi.advanceTimersByTimeAsync(90_000);
    await waitFor(() => expect(screen.getByTestId('extraction-status')).toHaveTextContent('Reading… 2 min — the model may still be busy with another request'));
  });
});

describe('a reader without data.write.contexts', () => {
  it('sees what is confirmed, and no review, sources, Add information or suggestions', async () => {
    const { authFetch } = mount({ auth: READER, claims: CONFIRMED });
    const region = await screen.findByRole('region', { name: 'What we know' });
    await waitFor(() => expect(within(region).getByText('vendor')).toBeInTheDocument());
    expect(within(region).queryByRole('list', { name: 'Claims to review' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Sources' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add information' })).toBeNull();
    expect(screen.queryByTestId('interview-suggestion')).toBeNull();
    expect(authFetch.mock.calls.map(c => c[0])).not.toContain('/api/contexts/c-app/interviews');
  });
});
