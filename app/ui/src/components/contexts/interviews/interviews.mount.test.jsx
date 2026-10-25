// @vitest-environment jsdom
// Context interviews on a context's page, mounted through ContextProfile the way
// the detail page uses it: the People block's suggestions from an interview,
// "What we know" (confirmed claims, the role timeline, the review list, the
// interviews) and the Upload interview card — and what a reader sees instead.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { POLL_MS } from './ClaimsProvider';
import { createElement as h } from 'react';
import ContextProfile from '@ui/components/contexts/profiles/ContextProfile';
import { PROFILES } from '@ui/components/contexts/profiles/profiles';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, within, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const APP = { id: 'c-app', displayName: 'Planner', contextCategory: 'LogicalApplication', targetType: 'Resource', directMemberCount: 3 };
const SRC = { intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01', fileName: 'gesprek.vtt', proposedBy: 'model' };

const ACCOUNTABLE = { id: 'cl-own', claimKind: 'role', status: 'proposed', principalId: 'p-anna', subjectName: 'interviewee', subjectDisplayName: 'Anna Voorbeeld', subjectMatch: 'interviewee', attribute: 'owner', value: 'owner of the planner', roleSuggestion: 'Accountable', quote: 'Yes, I am the owner of this app', ...SRC };
const RESPONSIBLE = { id: 'cl-piet', claimKind: 'role', status: 'proposed', principalId: 'p-piet', subjectName: 'Piet', subjectDisplayName: 'Piet Proefpersoon', subjectMatch: 'firstName', attribute: 'dayToDay', value: 'does the day-to-day', roleSuggestion: 'Responsible', quote: 'it is mostly Piet who does the day-to-day', ...SRC };
const UNMATCHED = { id: 'cl-karel', claimKind: 'role', status: 'proposed', subjectName: 'Karel', attribute: 'delegate', value: 'backup', roleSuggestion: 'Responsible', quote: 'Karel is my backup', ...SRC };
const PROPERTY = { id: 'cl-users', claimKind: 'property', status: 'proposed', attribute: 'users', value: 'about 400 nurses', quote: 'about 400 nurses', ...SRC };
const CONFIRMED = [
  { id: 'k-desc', claimKind: 'description', status: 'confirmed', value: 'Schedules the nursing shifts', quote: 'It schedules every shift', ...SRC },
  { id: 'k-vendor', claimKind: 'property', status: 'edited', attribute: 'vendor', value: 'Example Software', quote: 'bought from Example Software', ...SRC },
  { id: 'k-h1', claimKind: 'roleHistory', status: 'confirmed', principalId: 'p-bram', subjectDisplayName: 'Bram Test', value: 'junior', periodText: 'early years', ...SRC },
  { id: 'k-h2', claimKind: 'roleHistory', status: 'confirmed', principalId: 'p-bram', subjectDisplayName: 'Bram Test', value: 'architect CCoE', periodFrom: '2022-01-01', periodText: 'now', ...SRC },
];
const INTERVIEW = { id: 'iv-1', ...SRC, extractionStatus: 'done', extractionMessage: '1 claim was left out because the quote is not in the transcript.', proposed: 4, confirmed: 4 };

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

// The GET answers, by exact URL.
function getRoutes(state, doubt) {
  return new Map(Object.entries({
    '/api/contexts/c-app/claims': () => ({ data: state.claims, accountableDoubt: doubt }),
    '/api/contexts/c-app/interviews': () => ({ data: state.interviews }),
    '/api/contexts/c-app/interviews/iv-1/extract': () => jsonResponse({ id: 'iv-1', extractionStatus: 'pending' }, { status: 202 }),
    '/api/contexts/c-app/roles/suggestion': () => jsonResponse(undefined, { status: 204 }),
    '/api/contexts/c-app/roles': () => state.roles,
    '/api/contexts/c-app/relationships': () => [],
  }));
}

// A stateful API: the claims and roles change as the page decides them; every
// call is recorded. `conflictOnce` answers the first Accountable confirmation
// with the 409 the API gives when someone else is Accountable.
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

// What we know starts folded; most tests here read what is inside it, so they
// start with it open (as a reader who opened it earlier in the session would).
function mount({ auth = {}, open = true, ...opts } = {}) {
  window.sessionStorage.clear();
  if (open) window.sessionStorage.setItem('ia.whatWeKnow.open.c-app', '1');
  const { authFetch, state } = api(opts);
  renderWithProviders(h(ContextProfile, { profile: PROFILES.LogicalApplication, attrs: APP }), { auth: { authFetch, ...auth } });
  return { authFetch, state, user: userEvent.setup() };
}

const READER = { hasWildcard: false, permissions: new Set(['data.read']) };
const group = (name) => screen.getByRole('group', { name });
const whatWeKnow = () => screen.getByRole('region', { name: 'What we know' });

describe('the People block — suggestions from an interview', () => {
  it('shows the owner under Owner and the day-to-day person under Responsible, each with the quote and the interview', async () => {
    mount();
    const owner = await within(group('Owner')).findByTestId('interview-suggestion');
    expect(owner).toHaveTextContent(/^Suggested: Anna Voorbeeld· “Yes, I am the owner of this app” \(interview with Anna Voorbeeld, 2026-10-01\)ConfirmNot this personChoose someone else$/);
    const responsible = within(group('Responsible')).getAllByTestId('interview-suggestion');
    expect(responsible.map(r => r.textContent.split('·')[0])).toEqual(['Suggested: Piet Proefpersoon', 'Suggested: Karel']);
    // A match by first name alone is flagged; the interviewee is not.
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

  it('Not this person rejects the claim; Choose someone else confirms it for the person picked', async () => {
    const { state, user } = mount();
    const rows = await within(group('Responsible')).findAllByTestId('interview-suggestion');
    await user.click(within(rows[0]).getByRole('button', { name: 'Not this person' }));
    await user.click(within(rows[1]).getByRole('button', { name: 'Choose someone else' }));
    expect(screen.getByText('The interview said “Karel”')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Find the person who was meant' }), 'kar');
    await user.click(await screen.findByRole('button', { name: 'Karel Kiezer' }));
    await waitFor(() => expect(state.patches).toEqual([
      { id: 'cl-piet', body: { status: 'rejected' } },
      { id: 'cl-karel', body: { status: 'confirmed', principalId: 'p-karel' } },
    ]));
    await waitFor(() => expect(screen.queryByText('The interview said “Karel”')).toBeNull());
  });

  it('shows a doubt about the current Accountable under it', async () => {
    mount({ roles: [{ id: 'r-1', role: 'Accountable', principalId: 'p-anna', displayName: 'Anna Voorbeeld', addedBy: 'analyst' }],
      doubt: { claimId: 'c-x', quote: 'I am not really the owner', intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01' } });
    expect(await within(group('Owner')).findByTestId('accountable-doubt')).toHaveTextContent('In doubt: “I am not really the owner” (interview with Anna Voorbeeld, 2026-10-01)');
  });
});

describe('What we know', () => {
  it('groups the confirmed claims, each with its source, and draws the role timeline', async () => {
    mount();
    const region = await screen.findByRole('region', { name: 'What we know' });
    expect(within(region).getByText('Schedules the nursing shifts')).toBeInTheDocument();
    expect(within(region).getByText('vendor').nextElementSibling).toHaveTextContent(/^Example Software/);
    const timeline = within(region).getByTestId('role-timeline');
    expect(timeline).toHaveTextContent('Bram Test: architect CCoE (since 2022 (now)) → junior (early years)');
    expect(within(region).getAllByText('interview with Anna Voorbeeld, 2026-10-01').length).toBeGreaterThan(1);
  });

  it('a corrected or unsure claim says so in its row', async () => {
    const corrected = { ...PROPERTY, id: 'cl-m', claimKind: 'membership', subjectName: 'Gerrit', attribute: 'current', value: 'betrokken (corrected: the sentence says current; the model said former)', confidence: 0.8 };
    mount({ claims: [corrected, { ...UNMATCHED, confidence: 0.3 }] });
    const rows = within(await screen.findByRole('list', { name: 'Claims to review' })).getAllByTestId('claim-review-row');
    const row = (text) => rows.find(r => r.textContent.includes(text));
    expect(row('Gerrit')).toHaveTextContent('corrected: the sentence says current');
    expect(row('Gerrit')).not.toHaveTextContent('unsure — read the quote');
    expect(row('Karel')).toHaveTextContent('unsure — read the quote');
  });

  it('lists what is to review; Edit changes the value and confirms it', async () => {
    const { state, user } = mount();
    const list = await screen.findByRole('list', { name: 'Claims to review' });
    const rows = within(list).getAllByTestId('claim-review-row');
    expect(rows).toHaveLength(4);
    const property = rows.find(r => r.textContent.includes('users: about 400 nurses'));
    await user.click(within(property).getByRole('button', { name: 'Edit' }));
    const value = within(property).getByRole('textbox', { name: 'Value' });
    await user.clear(value);
    await user.type(value, 'about 450 nurses');
    await user.click(within(property).getByRole('button', { name: 'Save and confirm' }));
    await waitFor(() => expect(state.patches).toEqual([{ id: 'cl-users', body: { status: 'edited', value: 'about 450 nurses', periodText: null } }]));
    await waitFor(() => expect(within(whatWeKnow()).getByText('users').nextElementSibling).toHaveTextContent(/^about 450 nurses/));
  });

  it('a role claim with nobody matched asks who was meant before it confirms', async () => {
    const { state, user } = mount();
    const rows = within(await screen.findByRole('list', { name: 'Claims to review' })).getAllByTestId('claim-review-row');
    const karel = rows.find(r => r.textContent.includes('Karel'));
    expect(within(karel).queryByRole('button', { name: 'Confirm' })).toBeNull();
    await user.click(within(karel).getByRole('button', { name: 'Choose who and confirm' }));
    await user.type(screen.getByRole('textbox', { name: 'Find the person who was meant' }), 'kar');
    await user.click(await screen.findByRole('button', { name: 'Karel Kiezer' }));
    await waitFor(() => expect(state.patches).toEqual([{ id: 'cl-karel', body: { status: 'confirmed', principalId: 'p-karel' } }]));
  });

  it('Reject rejects; the interview list says what the run left out and reads it again on request', async () => {
    const { state, authFetch, user } = mount();
    const rows = within(await screen.findByRole('list', { name: 'Claims to review' })).getAllByTestId('claim-review-row');
    await user.click(within(rows[0]).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(state.patches).toEqual([{ id: 'cl-own', body: { status: 'rejected' } }]));
    const interviews = screen.getByRole('list', { name: 'Interviews' });
    expect(interviews).toHaveTextContent('Anna Voorbeeld2026-10-01 · gesprek.vttRead4 to review · 4 confirmed');
    expect(interviews).toHaveTextContent('1 claim was left out because the quote is not in the transcript.');
    await user.click(within(interviews).getByRole('button', { name: 'Read again' }));
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/c-app/interviews/iv-1/extract', { method: 'POST' });
  });

  it('a survey answer is listed as a survey, linked to it, with its answers to view and nothing to read again', async () => {
    const SURVEY = { id: 'iv-2', intervieweeName: 'Teije', interviewedAt: '2026-10-22', fileName: 'Unit roster (survey)', extractionStatus: 'done', surveyRequestId: 'ffffffff-0000-4000-8000-000000000001', proposed: 3, confirmed: 0 };
    mount({ interviews: [SURVEY] });
    const interviews = await screen.findByRole('list', { name: 'Interviews' });
    expect(within(interviews).getByRole('link', { name: 'survey' })).toHaveAttribute('href', '#surveys?request=ffffffff-0000-4000-8000-000000000001');
    expect(within(interviews).getByRole('button', { name: /View the transcript/ })).toHaveTextContent('View answers');
    expect(within(interviews).queryByRole('button', { name: 'Read again' })).not.toBeInTheDocument();
    expect(within(interviews).queryByTestId('extraction-status')).not.toBeInTheDocument();
  });

  it('Delete asks first, then deletes the interview', async () => {
    const { authFetch, user } = mount();
    const interviews = await screen.findByRole('list', { name: 'Interviews' });
    await user.click(within(interviews).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/What confirmed claims already changed stays/)).toBeInTheDocument();
    // The dialog's own Delete is the last one on the page.
    await user.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1));
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/contexts/c-app/interviews/iv-1', { method: 'DELETE' }));
  });

  it('shows nothing when there are no claims and no interviews', async () => {
    const { authFetch } = mount({ claims: [], interviews: [] });
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/contexts/c-app/interviews'));
    expect(screen.queryByRole('region', { name: 'What we know' })).toBeNull();
  });
});

describe('while an interview is being read', () => {
  afterEach(() => vi.useRealTimers());

  it('reads the interviews and claims again every few seconds, and stops once none is in progress', async () => {
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

  it('a run that goes on says how long, and that the model may be busy — and the line keeps ticking', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));
    mount({ interviews: [{ ...INTERVIEW, extractionStatus: 'running', extractionStartedAt: '2026-10-23T11:59:00Z' }] });
    const status = await screen.findByTestId('extraction-status');
    expect(status).toHaveTextContent(/^Reading…$/);
    await vi.advanceTimersByTimeAsync(90_000);
    await waitFor(() => expect(screen.getByTestId('extraction-status')).toHaveTextContent('Reading… 2 min — the model may still be busy with another request'));
  });
});

describe('the Upload interview card', () => {
  it('is in the Actions area for an analyst', async () => {
    mount();
    expect(await screen.findByTestId('action-upload-interview')).toHaveTextContent('Upload interview');
  });
});

describe('a reader without data.write.contexts', () => {
  it('sees what is confirmed, and no review, interviews, upload or suggestions', async () => {
    const { authFetch } = mount({ auth: READER, claims: CONFIRMED });
    const region = await screen.findByRole('region', { name: 'What we know' });
    expect(within(region).getByText('Schedules the nursing shifts')).toBeInTheDocument();
    // Only the fold toggle: no review, no transcript.
    expect(within(region).getAllByRole('button').map(b => b.getAttribute('aria-expanded'))).toEqual(['true']);
    expect(within(region).queryByRole('button', { name: 'View transcript' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Claims to review' })).toBeNull();
    expect(screen.queryByTestId('action-upload-interview')).toBeNull();
    expect(screen.queryByTestId('interview-suggestion')).toBeNull();
    expect(authFetch.mock.calls.map(c => c[0])).not.toContain('/api/contexts/c-app/interviews');
  });
});
