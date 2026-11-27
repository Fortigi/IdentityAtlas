// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import HoldersPanel from './HoldersPanel';
import ReviewRecord from './ReviewRecord';
import { CurrentOwners } from './OwnershipStep';
import ReviewRequestNotice from './ReviewRequestNotice';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, within, userEvent } from '@ui/test-utils/renderWithProviders';

const URL = '/api/access-package/br-1/assignments';

function mountPanel(answer) {
  const authFetch = makeAuthFetch((url) => (String(url) === URL ? answer() : undefined));
  renderWithProviders(h(HoldersPanel, { roleId: 'br-1' }), { auth: { authFetch, hasWildcard: false, permissions: new Set(['data.read']) } });
  return { authFetch, user: userEvent.setup() };
}
const open = (user) => user.click(screen.getByRole('button', { name: /See who has this role now/ }));

describe('HoldersPanel', () => {
  it('asks for nobody until it is opened, and closes again', async () => {
    const { authFetch, user } = mountPanel(() => [{ principalId: 'u1', targetDisplayName: 'Hank Holder', howHeld: ['Request'] }]);
    expect(authFetch).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /See who has this role now/ })).toHaveAttribute('aria-expanded', 'false');
    await open(user);
    expect(await screen.findByText('Hank Holder')).toBeInTheDocument();
    expect(screen.getByText('Nobody lost this role recently.')).toBeInTheDocument();
    await open(user);
    expect(screen.queryByText('Hank Holder')).toBeNull();
  });

  it('says so when nobody holds the role', async () => {
    const { user } = mountPanel(() => []);
    await open(user);
    expect(await screen.findByText('Nobody holds this role.')).toBeInTheDocument();
    expect(screen.getByText('Have it now (0)')).toBeInTheDocument();
  });

  it('names a holder by e-mail or id when there is no name', async () => {
    const { user } = mountPanel(() => [{ principalId: 'u1', targetUPN: 'hank@example.test' }, { principalId: 'u2' }]);
    await open(user);
    expect(await screen.findByText('hank@example.test')).toBeInTheDocument();
    expect(screen.getByText('u2')).toBeInTheDocument();
  });

  it('shows the first hundred of a long list and says where the rest is', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ principalId: `u${i}`, targetDisplayName: `Person ${i}` }));
    const { user } = mountPanel(() => many);
    await open(user);
    expect(await screen.findByText('Person 99')).toBeInTheDocument();
    expect(screen.queryByText('Person 100')).toBeNull();
    expect(screen.getByText(/The first 100 of 101\./)).toBeInTheDocument();
  });

  it('has no note about a rest for exactly a hundred', async () => {
    const { user } = mountPanel(() => Array.from({ length: 100 }, (_, i) => ({ principalId: `u${i}`, targetDisplayName: `Person ${i}` })));
    await open(user);
    expect(await screen.findByText('Person 99')).toBeInTheDocument();
    expect(screen.queryByText(/The first 100 of/)).toBeNull();
  });

  it('says so when the people cannot be loaded', async () => {
    const { user } = mountPanel(() => jsonResponse({ error: 'down' }, { ok: false, status: 500 }));
    await open(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the people.');
    expect(screen.queryByText('Have it now (0)')).toBeNull();
  });
});

describe('ReviewRecord', () => {
  const snapshot = { owners: [{ role: 'Accountable', principalId: 'p-ann', displayName: 'Ann' }] };
  const proposal = { accountable: { principalId: 'p-bob', displayName: 'Bob' }, responsible: [] };

  it('says so for a review without steps', () => {
    renderWithProviders(h(ReviewRecord, { steps: [], snapshot }));
    expect(screen.getByText('No steps were judged.')).toBeInTheDocument();
  });

  it('shows proposed people and words only where the verdict asks for a change or a question', () => {
    renderWithProviders(h(ReviewRecord, { snapshot, steps: [
      { step: 'ownership', verdict: 'good', remark: 'typed before changing my mind', proposal },
      { step: 'lifecycle', verdict: 'needsChange', remark: '  too wide  ', proposal: null },
      { step: 'contents', verdict: 'notUnderstood', remark: '' },
    ] }));
    const ownership = screen.getByTestId('record-ownership');
    expect(ownership).toHaveTextContent('Good');
    expect(ownership).not.toHaveTextContent('Bob');
    expect(ownership).not.toHaveTextContent('typed before');
    expect(within(screen.getByTestId('record-lifecycle')).getByText('too wide')).toBeInTheDocument();
    expect(screen.getByTestId('record-contents')).toHaveTextContent(/^PermissionsNot understood$/);
  });

  it('reads a proposal against the owners of the review, and copes without a snapshot', () => {
    renderWithProviders(h(ReviewRecord, { steps: [{ step: 'ownership', verdict: 'needsChange', remark: '', proposal }] }));
    expect(screen.getByTestId('record-ownership')).toHaveTextContent('Make Bob Accountable');
  });
});

describe('CurrentOwners', () => {
  it('says Nobody for an empty place and names a holder without a name', () => {
    renderWithProviders(h(CurrentOwners, { snapshot: { owners: [{ role: 'Responsible', principalId: 'p-x', displayName: null }] } }));
    const now = screen.getByRole('region', { name: 'Who answers for this role now' });
    expect(now).toHaveTextContent('AccountableNobody');
    expect(now).toHaveTextContent('ResponsibleUnnamed');
  });

  it('copes with no snapshot at all', () => {
    renderWithProviders(h(CurrentOwners, { snapshot: null }));
    expect(screen.getAllByText('Nobody')).toHaveLength(2);
  });
});

describe('ReviewRequestNotice', () => {
  const REQUEST = { id: 'q-1', campaignName: 'Yearly role review', steps: ['contents'], dueAt: '2030-12-31T23:59:59Z', overdue: true };
  function mountNotice(body) {
    const onStart = vi.fn();
    const authFetch = makeAuthFetch((url) => (String(url) === '/api/access-package/br-1/composition-reviews' ? body : undefined));
    renderWithProviders(h(ReviewRequestNotice, { roleId: 'br-1', onStart }), { auth: { authFetch, hasWildcard: false, permissions: new Set(['data.read']) } });
    return { onStart, authFetch, user: userEvent.setup() };
  }

  it('tells an asked person a review waits, that it is late, and starts it', async () => {
    const { onStart, user } = mountNotice({ canReview: true, request: REQUEST });
    const notice = await screen.findByTestId('review-request-notice');
    expect(notice).toHaveTextContent('A review is waiting for you.');
    expect(notice).toHaveTextContent('That date has passed.');
    await user.click(within(notice).getByRole('button', { name: 'Start the review' }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('shows nothing to someone nobody asks, or who may not review', async () => {
    const quiet = mountNotice({ canReview: true, request: null });
    await waitFor(() => expect(quiet.authFetch).toHaveBeenCalled());
    expect(screen.queryByTestId('review-request-notice')).toBeNull();
  });

  it('shows nothing when the request is there but the person may not review', async () => {
    const closed = mountNotice({ canReview: false, request: REQUEST });
    await waitFor(() => expect(closed.authFetch).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByTestId('review-request-notice')).toBeNull();
  });
});
