// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import BusinessRoleCompositionReview from './BusinessRoleCompositionReview';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, within, userEvent } from '@ui/test-utils/renderWithProviders';

// The improvements step of the review wizard, against a fake API: role
// mining's suggestions come from …/composition-reviews/improvements.

const BASE = '/api/access-package/br-1';
const URL = `${BASE}/composition-reviews`;
const MINING = `${URL}/improvements`;
const NOW = { version: 2, role: { displayName: 'Finance', holderCount: 12 }, type: { control: 'Manual', waysIn: ['Request'], waysOut: ['Review'] }, resources: [], policies: [], owners: [], participants: [] };
const SUMMARY = { reviews: [], current: NOW, latestReview: null, steps: ['improvements'], verdicts: ['good', 'needsChange', 'notUnderstood'], canReview: true };
const PERMISSION = {
  key: 'permission:g9', kind: 'addPermission', confidence: 100, exact: true,
  resource: { id: 'g9', displayName: 'SG-Data', resourceType: 'Group', createdDateTime: null },
  recent: false, holders: 12, holdersWithIt: 12, othersWithIt: 0,
};
const RULE = {
  key: 'rule:department=Finance', kind: 'automaticRule', confidence: 96, exact: false,
  conditions: [{ attribute: 'department', value: 'Finance' }], holders: 25, holdersMatched: 24, othersMatched: 0,
};
const found = (suggestions, extra = {}) => ({ suggestions, declinedBefore: 0, handedOutByHand: true, holderCount: 12, thresholds: { confidence: 95, holders: 5, recentDays: 90 }, ...extra });

function mount({ answers = [found([PERMISSION, RULE])], postError = null } = {}) {
  const state = { posts: [], minings: 0 };
  const authFetch = makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    if (u === MINING) {
      const answer = answers[Math.min(state.minings, answers.length - 1)];
      state.minings += 1;
      return answer === 'fail' ? jsonResponse({ error: 'down' }, { ok: false, status: 500 }) : answer;
    }
    if (u !== URL) return undefined;
    if (opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      state.posts.push(body);
      if (postError) return jsonResponse({ error: postError }, { ok: false, status: 400 });
      return jsonResponse({ id: 'r9', notes: body.notes, steps: [], reviewedAt: '2026-11-28T12:00:00Z', snapshot: NOW }, { status: 201 });
    }
    return SUMMARY;
  });
  renderWithProviders(h(BusinessRoleCompositionReview, { roleId: 'br-1', data: {} }), { auth: { authFetch, hasWildcard: false, permissions: new Set(['data.read']) } });
  return { state, user: userEvent.setup() };
}

const start = async (user) => {
  await user.click(await screen.findByRole('button', { name: 'Review this role' }));
  return screen.findByTestId('review-wizard');
};
const decide = (user, key, label) => user.click(within(screen.getByTestId(`suggestion-${key}`)).getByRole('radio', { name: label }));
const next = (wizard) => within(wizard).getByRole('button', { name: 'Next' });

describe('the improvements step', () => {
  it('shows each suggestion with how sure it is and why, and goes on only once each is decided', async () => {
    const { state, user } = mount();
    const wizard = await start(user);
    expect(await within(wizard).findByText('Add SG-Data to the role')).toBeInTheDocument();
    expect(within(wizard).getByText('100% sure')).toBeInTheDocument();
    expect(within(wizard).getByText(/All 12 people who hold this role have it themselves, nobody else has it/)).toBeInTheDocument();
    expect(within(wizard).getByText('Hand it out automatically to everyone whose department is "Finance"')).toBeInTheDocument();
    expect(within(wizard).getByText('96% sure')).toBeInTheDocument();
    expect(next(wizard)).toBeDisabled();
    expect(within(wizard).getByText('Decide on every suggestion')).toBeInTheDocument();

    await decide(user, PERMISSION.key, 'Propose this');
    expect(next(wizard)).toBeDisabled();
    await decide(user, RULE.key, 'Not for this role');
    expect(next(wizard)).toBeEnabled();
    await user.type(within(wizard).getByLabelText('Anything to add about what you propose? (optional)'), 'Everyone in Finance uses it');
    await user.click(next(wizard));

    const record = await within(wizard).findByTestId('record-improvements');
    expect(within(record).getByText('Needs a change')).toBeInTheDocument();
    expect(record).toHaveTextContent('Add SG-Data to the role (100% sure): Proposed');
    expect(record).toHaveTextContent('(96% sure): Declined');
    await user.click(within(wizard).getByRole('button', { name: 'Sign and finish the review' }));
    await waitFor(() => expect(state.posts).toEqual([{
      steps: [{ step: 'improvements', decisions: [{ key: PERMISSION.key, decision: 'adopt' }, { key: RULE.key, decision: 'decline' }], remark: 'Everyone in Finance uses it' }],
      notes: '',
    }]));
  });

  it('asks for the question of a reviewer who does not understand a suggestion', async () => {
    const { state, user } = mount({ answers: [found([PERMISSION])] });
    const wizard = await start(user);
    await within(wizard).findByText('Add SG-Data to the role');
    expect(within(wizard).getByText('Decide on the suggestion')).toBeInTheDocument();
    expect(within(wizard).queryByRole('textbox')).toBeNull();
    await decide(user, PERMISSION.key, 'I do not understand this');
    await user.type(within(wizard).getByLabelText('What is your question?'), 'What is SG-Data?');
    await user.click(next(wizard));
    await user.click(await within(wizard).findByRole('button', { name: 'Sign and finish the review' }));
    await waitFor(() => expect(state.posts[0].steps).toEqual([
      { step: 'improvements', decisions: [{ key: PERMISSION.key, decision: 'notUnderstood' }], remark: 'What is SG-Data?' },
    ]));
  });

  it('says plainly when role mining found nothing, and why that can be', async () => {
    const { state, user } = mount({ answers: [found([], { holderCount: 3, declinedBefore: 2 })] });
    const wizard = await start(user);
    const none = await within(wizard).findByTestId('improvements-none');
    expect(none).toHaveTextContent('Role mining found no improvements for this role.');
    expect(none).toHaveTextContent('at least 95% sure');
    expect(none).toHaveTextContent('With fewer than 5 people holding the role there is too little to go on.');
    expect(within(wizard).getByText('2 suggestions were declined in the last review and are not asked again.')).toBeInTheDocument();
    await user.click(next(wizard));
    expect(await within(wizard).findByTestId('record-improvements')).toHaveTextContent('Role mining found no improvements.');
    await user.click(within(wizard).getByRole('button', { name: 'Sign and finish the review' }));
    await waitFor(() => expect(state.posts[0].steps).toEqual([{ step: 'improvements', decisions: [], remark: '' }]));
  });

  it('leaves out the note about few holders for a role with enough of them', async () => {
    const { user } = mount({ answers: [found([], { declinedBefore: 1 })] });
    const wizard = await start(user);
    expect(await within(wizard).findByTestId('improvements-none')).not.toHaveTextContent('too little to go on');
    expect(within(wizard).getByText('1 suggestion was declined in the last review and is not asked again.')).toBeInTheDocument();
  });

  it('offers to look again when role mining fails, and does not let the reviewer go on meanwhile', async () => {
    const { user } = mount({ answers: ['fail', found([PERMISSION])] });
    const wizard = await start(user);
    const alert = await within(wizard).findByRole('alert');
    expect(alert).toHaveTextContent('Could not look for improvements.');
    expect(next(wizard)).toBeDisabled();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await within(wizard).findByText('Add SG-Data to the role')).toBeInTheDocument();
  });

  it('asks role mining again, from the step, when the suggestions changed before signing', async () => {
    const CHANGED = 'The suggestions changed while you were reviewing. Open the step Improvements again and decide on what it shows now.';
    const { state, user } = mount({ answers: [found([PERMISSION]), found([RULE])], postError: CHANGED });
    const wizard = await start(user);
    await within(wizard).findByText('Add SG-Data to the role');
    await decide(user, PERMISSION.key, 'Propose this');
    await user.click(next(wizard));
    await user.click(await within(wizard).findByRole('button', { name: 'Sign and finish the review' }));
    expect(await within(wizard).findByText(CHANGED)).toBeInTheDocument();
    expect(await within(wizard).findByText('Hand it out automatically to everyone whose department is "Finance"')).toBeInTheDocument();
    expect(within(wizard).queryByText('Add SG-Data to the role')).toBeNull();
    expect(next(wizard)).toBeDisabled();
    expect(state.minings).toBe(2);
  });
});
