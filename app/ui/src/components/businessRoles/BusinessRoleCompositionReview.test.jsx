// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import BusinessRoleCompositionReview from './BusinessRoleCompositionReview';
import { changeText } from './accessModel';
import { SharedViewContext } from '@ui/contexts/SharedViewContext';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, within, userEvent } from '@ui/test-utils/renderWithProviders';

const BASE = '/api/access-package/br-1';
const URL = `${BASE}/composition-reviews`;
const STEPS = ['ownership', 'lifecycle', 'contents'];
const VERDICTS = ['good', 'needsChange', 'notUnderstood'];
const res = (id, displayName) => ({ id, displayName, resourceType: 'Group', systemName: 'Entra ID' });
const MARA = { role: 'Accountable', displayName: 'Mara Lindqvist', principalId: 'p-mara', identityId: null };
const RITA = { role: 'Responsible', displayName: 'Rita Review', principalId: 'p-rita', identityId: null, derivedFrom: ['Reviewer'] };
const picture = (resources, control = 'Manual') => ({
  version: 2, takenAt: '2026-11-20T10:00:00Z',
  role: { displayName: 'Finance', holderCount: 12 },
  type: { control, waysIn: ['Request'], waysOut: ['Review'], reviewGap: false },
  resources, policies: [{ id: 'p1', displayName: 'Request it', waysIn: ['Request'], waysOut: ['Review'], targetRule: null }],
  owners: [MARA, RITA],
  participants: [{ policyId: 'p1', participation: 'Approver', subjectType: 'User', principalId: 'p-carla', displayName: 'Carla Cash', stage: 1 }],
});
const step = (name, verdict = 'good', remark = '', proposal = null) => ({ step: name, verdict, remark, proposal });
const CLEAN = {
  id: 'r1', notes: 'All three groups belong here.', reviewedBy: 'ann@example.test', reviewedByName: 'Ann Analyst',
  reviewedAt: '2026-11-20T10:00:00Z', snapshot: picture([res('g1', 'SG-Finance'), res('g2', 'SG-Payroll'), res('g3', 'SG-Audit')]),
  steps: STEPS.map(s => step(s)), outcome: 'noFindings',
};
const FOUND = {
  id: 'r2', notes: '', reviewedBy: 'bob@example.test', reviewedAt: '2026-11-22T09:00:00Z', snapshot: picture([]),
  steps: [
    step('ownership', 'needsChange', '', { accountable: { principalId: 'p-bob', displayName: 'Bob Builder' }, responsible: [{ principalId: 'p-rita', displayName: 'Rita Review' }] }),
    step('lifecycle'),
    step('contents', 'notUnderstood', 'What is SG-HR for?'),
  ],
  outcome: 'findings',
};
const NOW = picture([res('g1', 'SG-Finance'), res('g2', 'SG-Payroll'), res('g3', 'SG-Audit'), res('g4', 'SG-HR')]);
const LATEST = { ...FOUND, changesSince: { added: ['SG-HR'], removed: [], type: null, policiesChanged: true, ownersChanged: false } };
const SUMMARY = { reviews: [FOUND, CLEAN], current: NOW, latestReview: LATEST, steps: STEPS, verdicts: VERDICTS, canReview: true };
const HOLDERS = [
  { principalId: 'u1', targetDisplayName: 'Hank Holder', howHeld: ['Request'] },
  { principalId: 'u2', targetDisplayName: 'Lea Leaver', deleted: true, deletedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() },
  { principalId: 'u3', targetDisplayName: 'Olga Old', deleted: true, deletedAt: '2020-01-01T00:00:00Z' },
];
const ROLE_DATA = { accessModel: { control: 'Manual', waysIn: ['Request'], waysOut: ['Review'], reviewGap: false }, assignmentCount: 12, automaticHolderCount: 0 };

function api({ summary = SUMMARY, postError = null, failGet = false } = {}) {
  const state = { posts: [], searches: [], summary };
  const authFetch = makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    if (u.startsWith(`${URL}/people?`)) {
      state.searches.push(u);
      return { data: [{ id: 'p-carla', displayName: 'Carla Cash', userPrincipalName: 'carla@example.test' }] };
    }
    if (u === `${BASE}/policies`) return [{ id: 'p1', displayName: 'Request it', allowsRequest: true, hasAccessReview: true, requiresApproval: true, holderCount: 12 }];
    if (u === `${BASE}/participants`) return [{ participation: 'Approver', subjectType: 'User', principalId: 'p-carla', displayName: 'Carla Cash', stage: 1 }];
    if (u === `${BASE}/resource-roles`) return [{ childResourceId: 'g1', resourceDisplayName: 'SG-Finance', resourceType: 'Group', roleName: 'Member' }];
    if (u === `${BASE}/assignments`) return HOLDERS;
    if (u !== URL) return undefined;
    if (opts.method === 'POST') {
      if (postError) return jsonResponse({ error: postError }, { ok: false, status: 400 });
      const body = JSON.parse(opts.body);
      state.posts.push(body);
      const saved = { id: `r${state.posts.length + 2}`, notes: body.notes, steps: body.steps, reviewedBy: 'me@example.test', reviewedAt: '2026-11-24T12:00:00Z', snapshot: NOW };
      state.summary = { ...state.summary, reviews: [saved, ...state.summary.reviews], latestReview: { ...saved, changesSince: {} } };
      return jsonResponse(saved, { status: 201 });
    }
    if (failGet) return jsonResponse({ error: 'down' }, { ok: false, status: 500 });
    return state.summary;
  });
  return { authFetch, state };
}

// Who may review is the API's answer (canReview), not a permission the page checks.
const AUTH = { hasWildcard: false, permissions: new Set(['data.read']) };

function mount({ shared = false, startReview = false, ...opts } = {}) {
  const { authFetch, state } = api(opts);
  const el = h(BusinessRoleCompositionReview, { roleId: 'br-1', data: ROLE_DATA, startReview });
  renderWithProviders(shared ? h(SharedViewContext.Provider, { value: true }, el) : el, { auth: { authFetch, ...AUTH } });
  return { state, user: userEvent.setup() };
}

const start = async (user) => {
  await user.click(await screen.findByRole('button', { name: 'Review this role' }));
  return screen.findByTestId('review-wizard');
};
const choose = (user, wizard, label) => user.click(within(wizard).getByRole('radio', { name: label }));
const next = (wizard) => within(wizard).getByRole('button', { name: 'Next' });
const GOOD = 'Good';
const CHANGE = 'Needs a change';
const LOST = 'I do not understand what I am reading';

describe('changeText', () => {
  it('names resources added and removed, a type change, a policy change and other owners', () => {
    expect(changeText({ added: ['A', 'B'], removed: ['C'] })).toBe('Since then: added A, B; removed C.');
    expect(changeText({ type: { from: 'Manual', to: 'Automatic' } })).toBe('Since then: the type changed from Manual to Rule based.');
    expect(changeText({ type: { from: 'Unknown', to: 'Weird' } })).toBe('Since then: the type changed from Unknown to Unknown.');
    expect(changeText({ removed: ['C'], policiesChanged: true })).toBe('Since then: removed C; a policy or its rule changed.');
    expect(changeText({ ownersChanged: true })).toBe('Since then: other people answer for it.');
    expect(changeText({ policiesChanged: true, ownersChanged: true })).toBe('Since then: a policy or its rule changed; other people answer for it.');
  });

  it('is null when nothing changed', () => {
    expect(changeText({ added: [], removed: [], type: null, policiesChanged: false, ownersChanged: false })).toBeNull();
    expect(changeText()).toBeNull();
  });
});

describe('the review status and history', () => {
  it('says who reviewed last, what they found, and what changed since', async () => {
    mount();
    const status = await screen.findByTestId('review-status');
    expect(within(status).getByTestId('review-outcome')).toHaveTextContent('Reviewed: 2 findings');
    expect(status).toHaveTextContent('by bob@example.test on');
    expect(within(status).getByRole('alert')).toHaveTextContent('Since then: added SG-HR; a policy or its rule changed.');
  });

  it('calls a latest review without findings just that, with no alert when nothing changed', async () => {
    mount({ summary: { ...SUMMARY, reviews: [CLEAN], latestReview: { ...CLEAN, changesSince: { added: [], removed: [] } } } });
    const status = await screen.findByTestId('review-status');
    expect(within(status).getByTestId('review-outcome')).toHaveTextContent('Reviewed: no findings');
    expect(status).toHaveTextContent('by Ann Analyst on');
    expect(within(status).queryByRole('alert')).toBeNull();
  });

  it('says so while nobody has reviewed it, and still offers to', async () => {
    mount({ summary: { ...SUMMARY, reviews: [], latestReview: null } });
    const status = await screen.findByTestId('review-status');
    expect(status).toHaveTextContent('Nobody has reviewed this role yet.');
    expect(within(status).getByRole('button', { name: 'Review this role' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Earlier reviews' })).toBeNull();
  });

  it('lists every review, newest first, with what it said per step', async () => {
    mount();
    const history = await screen.findByRole('region', { name: 'Earlier reviews' });
    const [newest, older] = within(history).getAllByTestId('review');
    expect(newest).toHaveTextContent('bob@example.test');
    expect(within(newest).getByTestId('review-outcome')).toHaveTextContent('2 findings');
    const ownership = within(newest).getByTestId('record-ownership');
    expect(ownership).toHaveTextContent('Needs a change');
    expect(ownership).toHaveTextContent('Accountable: Bob Builder instead of Mara Lindqvist');
    expect(within(newest).getByTestId('record-lifecycle')).toHaveTextContent('Good');
    const contents = within(newest).getByTestId('record-contents');
    expect(contents).toHaveTextContent('Not understood');
    expect(contents).toHaveTextContent('What is SG-HR for?');
    expect(newest).not.toHaveTextContent('General comments');

    expect(older).toHaveTextContent('Ann Analyst');
    expect(within(older).getByTestId('review-outcome')).toHaveTextContent('no findings');
    expect(older).toHaveTextContent('General comments');
    expect(older).toHaveTextContent('All three groups belong here.');
  });

  it('shows what each review looked at, as it was then, with who approved', async () => {
    const { user } = mount();
    const history = await screen.findByRole('region', { name: 'Earlier reviews' });
    const summaries = within(history).getAllByText('What was reviewed');
    await user.click(summaries[1]);
    const snapshot = within(summaries[1].closest('details')).getByTestId('role-snapshot');
    expect(within(snapshot).getByText('SG-Audit')).toBeInTheDocument();
    expect(within(snapshot).queryByText('SG-HR')).toBeNull();
    expect(snapshot).toHaveTextContent('Resources (3)');
    expect(snapshot).toHaveTextContent('Who approved a request');
    expect(snapshot).toHaveTextContent('Carla Cash');
    expect(snapshot).not.toHaveTextContent('Who reviewed the holders');
  });

  it('gives someone the API says may not review the reviews without the button', async () => {
    mount({ summary: { ...SUMMARY, canReview: false } });
    await screen.findByTestId('review-status');
    expect(screen.queryByRole('button', { name: 'Review this role' })).toBeNull();
  });

  it('offers no review in a shared view, whatever the API says', async () => {
    mount({ shared: true });
    await screen.findByTestId('review-status');
    expect(screen.queryByRole('button', { name: 'Review this role' })).toBeNull();
  });

  it('offers no review while the API names no steps to judge', async () => {
    mount({ summary: { ...SUMMARY, steps: [] } });
    await screen.findByTestId('review-status');
    expect(screen.queryByRole('button', { name: 'Review this role' })).toBeNull();
  });

  it('says so when the reviews cannot be loaded', async () => {
    mount({ failGet: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('The reviews could not be loaded');
  });
});

describe('the review wizard', () => {
  it('walks through the steps, each needing a verdict, and saves the whole review on signing', async () => {
    const { state, user } = mount();
    const wizard = await start(user);
    expect(screen.queryByTestId('review-status')).toBeNull();

    // Step 1: who answers for it, as it is now.
    const owners = within(wizard).getByRole('region', { name: 'Who answers for this role now' });
    expect(owners).toHaveTextContent('Mara Lindqvist');
    expect(owners).toHaveTextContent('Rita Review (reviewer in a policy)');
    expect(next(wizard)).toBeDisabled();
    await choose(user, wizard, GOOD);
    expect(within(wizard).queryByLabelText('What should change?')).toBeNull();
    await user.click(next(wizard));

    // Step 2: the lifecycle, with who approves; a change needs words.
    expect(await within(wizard).findByText('Who approves')).toBeInTheDocument();
    expect(within(wizard).getByText('Carla Cash')).toBeInTheDocument();
    await choose(user, wizard, CHANGE);
    expect(next(wizard)).toBeDisabled();
    expect(within(wizard).getByText('Describe the change you propose')).toBeInTheDocument();
    await user.type(within(wizard).getByLabelText('What should change?'), 'The approver left the company.');
    await user.click(next(wizard));

    // Step 3: the permissions; a question may stay empty, or be asked.
    expect(await within(wizard).findByText('SG-Finance')).toBeInTheDocument();
    await choose(user, wizard, LOST);
    expect(next(wizard)).toBeEnabled();
    await user.type(within(wizard).getByLabelText('What is your question?'), 'What does Member give?');
    await user.click(next(wizard));

    // Step 4: what was said, room for more, and the signature.
    const mine = within(wizard).getByRole('region', { name: 'Your review' });
    expect(mine).toHaveTextContent('Your review: 2 findings');
    expect(within(mine).getByTestId('record-lifecycle')).toHaveTextContent('The approver left the company.');
    expect(state.posts).toEqual([]);
    await user.type(within(wizard).getByLabelText('Anything else?'), 'Split this role in two.');
    await user.click(within(wizard).getByRole('button', { name: 'Sign and finish the review' }));

    await waitFor(() => expect(state.posts).toEqual([{
      steps: [
        { step: 'ownership', verdict: 'good', remark: '' },
        { step: 'lifecycle', verdict: 'needsChange', remark: 'The approver left the company.' },
        { step: 'contents', verdict: 'notUnderstood', remark: 'What does Member give?' },
      ],
      notes: 'Split this role in two.',
    }]));
    await waitFor(() => expect(screen.queryByTestId('review-wizard')).toBeNull());
    expect(await screen.findByText('Split this role in two.')).toBeInTheDocument();
  });

  it('lets a reviewer propose other people from the directory instead of describing them', async () => {
    const { state, user } = mount();
    const wizard = await start(user);
    expect(within(wizard).queryByTestId('proposed-owners')).toBeNull();
    await choose(user, wizard, CHANGE);
    const proposed = within(wizard).getByTestId('proposed-owners');
    expect(next(wizard)).toBeDisabled();
    expect(within(wizard).getByText('Choose who it should be, or describe the change')).toBeInTheDocument();

    await user.type(within(proposed).getByLabelText('Propose someone else'), 'car');
    await user.click(await within(proposed).findByRole('button', { name: /carla@example.test/ }));
    expect(state.searches).toEqual([`${URL}/people?search=car`]);
    expect(within(proposed).getByTestId('proposed-changes')).toHaveTextContent('Accountable: Carla Cash instead of Mara Lindqvist');
    await user.click(within(proposed).getByRole('button', { name: 'Remove Rita Review as Responsible' }));
    expect(within(proposed).getByTestId('proposed-changes')).toHaveTextContent('Remove Rita Review as Responsible');
    expect(next(wizard)).toBeEnabled();

    await user.click(next(wizard));
    await choose(user, wizard, GOOD);
    await user.click(next(wizard));
    await choose(user, wizard, GOOD);
    await user.click(next(wizard));
    expect(within(wizard).getByTestId('record-ownership')).toHaveTextContent('Accountable: Carla Cash instead of Mara Lindqvist');
    await user.click(within(wizard).getByRole('button', { name: 'Sign and finish the review' }));
    await waitFor(() => expect(state.posts).toHaveLength(1));
    expect(state.posts[0].steps[0]).toEqual({
      step: 'ownership', verdict: 'needsChange', remark: '',
      proposal: { accountable: { principalId: 'p-carla' }, responsible: [] },
    });
  });

  it('adds a Responsible person once, proposes nobody Accountable, and undoes the choices', async () => {
    const { user } = mount();
    const wizard = await start(user);
    await choose(user, wizard, CHANGE);
    const proposed = within(wizard).getByTestId('proposed-owners');
    const add = async () => {
      await user.type(within(proposed).getByLabelText('Add a person'), 'car');
      await user.click(await within(proposed).findByRole('button', { name: /carla@example.test/ }));
    };
    await add();
    await add();
    expect(within(within(proposed).getByRole('list', { name: 'Proposed Responsible' })).getAllByRole('listitem')).toHaveLength(2);
    expect(within(proposed).getByTestId('proposed-changes')).toHaveTextContent('Add Carla Cash as Responsible');
    await user.click(within(proposed).getByRole('button', { name: 'Nobody' }));
    expect(within(proposed).getByTestId('proposed-changes')).toHaveTextContent('Nobody Accountable instead of Mara Lindqvist');
    expect(within(proposed).queryByRole('button', { name: 'Nobody' })).toBeNull();
    await user.click(within(proposed).getByRole('button', { name: 'Undo these choices' }));
    expect(within(proposed).queryByTestId('proposed-changes')).toBeNull();
    expect(next(wizard)).toBeDisabled();
  });

  it('keeps who has the role and who lost it recently one click away on the lifecycle step', async () => {
    const { user } = mount();
    const wizard = await start(user);
    await choose(user, wizard, GOOD);
    await user.click(next(wizard));
    const panel = await within(wizard).findByRole('region', { name: 'Who has this role' });
    expect(panel).not.toHaveTextContent('Hank Holder');
    await user.click(within(panel).getByRole('button', { name: /See who has this role now/ }));
    expect(await within(panel).findByText('Hank Holder')).toBeInTheDocument();
    expect(panel).toHaveTextContent('Have it now (1)');
    expect(panel).toHaveTextContent('Lost it in the last 90 days (1)');
    expect(panel).toHaveTextContent('Lea Leaver');
    expect(panel).toHaveTextContent('lost it on');
    expect(panel).not.toHaveTextContent('Olga Old');
  });

  it('goes back without losing an answer, and leaves without saving on Cancel', async () => {
    const { state, user } = mount();
    const wizard = await start(user);
    expect(within(wizard).getByRole('button', { name: 'Back' })).toBeDisabled();
    await choose(user, wizard, LOST);
    await user.type(within(wizard).getByLabelText('What is your question?'), 'Who is Mara?');
    await user.click(next(wizard));
    await within(wizard).findByText('Who approves');
    await user.click(within(wizard).getByRole('button', { name: 'Back' }));
    expect(within(wizard).getByRole('radio', { name: LOST })).toBeChecked();
    expect(within(wizard).getByLabelText('What is your question?')).toHaveValue('Who is Mara?');
    await user.click(within(wizard).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByTestId('review-status')).toBeInTheDocument();
    expect(state.posts).toEqual([]);
  });

  it('shows the API error on signing and keeps the review open', async () => {
    const { user } = mount({ postError: 'Say what should change, or choose the people it should be', summary: { ...SUMMARY, steps: ['contents'] } });
    const wizard = await start(user);
    await choose(user, wizard, GOOD);
    await user.click(next(wizard));
    await user.click(within(wizard).getByRole('button', { name: 'Sign and finish the review' }));
    expect(await within(wizard).findByText('Say what should change, or choose the people it should be')).toBeInTheDocument();
    expect(within(wizard).getByRole('region', { name: 'Your review' })).toHaveTextContent('Your review: no findings');
  });

  it('asks only the steps the API names', async () => {
    const { state, user } = mount({ summary: { ...SUMMARY, steps: ['contents'] } });
    const wizard = await start(user);
    expect(within(wizard).queryByRole('region', { name: 'Who answers for this role now' })).toBeNull();
    expect(await within(wizard).findByText('SG-Finance')).toBeInTheDocument();
    await choose(user, wizard, GOOD);
    await user.click(next(wizard));
    await user.click(within(wizard).getByRole('button', { name: 'Sign and finish the review' }));
    await waitFor(() => expect(state.posts).toEqual([{ steps: [{ step: 'contents', verdict: 'good', remark: '' }], notes: '' }]));
  });
});

describe('a review a campaign asks for', () => {
  const REQUEST = { id: 'q-1', campaignName: 'Yearly role review', steps: ['contents'], dueAt: '2030-12-31T23:59:59Z', overdue: false };

  it('says which campaign asks, and reviews only the steps it asks', async () => {
    const { state, user } = mount({ summary: { ...SUMMARY, request: REQUEST } });
    expect(await screen.findByTestId('review-request')).toHaveTextContent('The campaign "Yearly role review" asks you to review this role by');
    const wizard = await start(user);
    expect(within(wizard).queryByRole('region', { name: 'Who answers for this role now' })).toBeNull();
    await choose(user, wizard, GOOD);
    await user.click(next(wizard));
    await user.click(within(wizard).getByRole('button', { name: 'Sign and finish the review' }));
    await waitFor(() => expect(state.posts).toEqual([{ steps: [{ step: 'contents', verdict: 'good', remark: '' }], notes: '' }]));
  });

  it('reviews every step when the request names none, and for someone nobody asks', async () => {
    const { user } = mount({ summary: { ...SUMMARY, request: { ...REQUEST, steps: [] } } });
    const wizard = await start(user);
    expect(within(wizard).getByRole('region', { name: 'Who answers for this role now' })).toBeInTheDocument();
  });

  it('does not show the request to someone who may not review, or in a shared view', async () => {
    mount({ summary: { ...SUMMARY, request: REQUEST, canReview: false } });
    await screen.findByTestId('review-status');
    expect(screen.queryByTestId('review-request')).toBeNull();
  });

  it('has no request line while nobody asks', async () => {
    mount();
    await screen.findByTestId('review-status');
    expect(screen.queryByTestId('review-request')).toBeNull();
  });

  it('opens straight on the wizard when the page asks it to, and not for someone who may not review', async () => {
    mount({ startReview: true, summary: { ...SUMMARY, request: REQUEST } });
    expect(await screen.findByTestId('review-wizard')).toBeInTheDocument();
  });

  it('stays on the status for someone who may not review, even when asked to open the wizard', async () => {
    mount({ startReview: true, summary: { ...SUMMARY, canReview: false } });
    expect(await screen.findByTestId('review-status')).toBeInTheDocument();
    expect(screen.queryByTestId('review-wizard')).toBeNull();
  });
});
