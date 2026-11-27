// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import ReviewCampaignsTab from './ReviewCampaignsTab';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, within, userEvent } from '@ui/test-utils/renderWithProviders';

const ID = 'c1';
const ROUND = { number: 1, startsAt: '2026-12-01T00:00:00Z', dueAt: '2026-12-31T23:59:59Z', overdue: false, total: 3, reviewed: 1, findings: 1, noAccountable: 1, waiting: 1 };
const CAMPAIGN = {
  id: ID, name: 'Yearly finance review', steps: ['ownership', 'contents'], startsOn: '2026-12-01', intervalMonths: 12, dueDays: 30,
  endedAt: null, status: 'running', roleCount: 1, portfolioCount: 1, round: ROUND, nextRoundOn: '2027-12-01',
};
const PLANNED = { ...CAMPAIGN, id: 'c2', name: 'Spring check', status: 'planned', intervalMonths: null, round: null, nextRoundOn: '2027-03-01', startsOn: '2027-03-01', roleCount: 2, portfolioCount: 0 };
const DETAIL = {
  ...CAMPAIGN,
  scope: { roles: [{ id: 'r4', displayName: 'Loose role' }], portfolios: [{ id: 'p1', displayName: 'Finance roles' }] },
  requests: [
    { id: 'q1', roleId: 'r1', roleName: 'Controller', portfolioName: 'Finance roles', accountable: 'Carla Cash', status: 'findings', reviewId: 'v1', reviewedBy: 'carla@example.test', reviewedByName: 'Carla Cash', reviewedAt: '2026-12-03T10:00:00Z' },
    { id: 'q2', roleId: 'r2', roleName: 'Payroll clerk', portfolioName: 'Finance roles', accountable: null, status: 'noAccountable' },
    { id: 'q3', roleId: 'r4', roleName: 'Loose role', portfolioName: null, accountable: 'Bob Builder', status: 'waiting' },
  ],
};
const OPTIONS = {
  roles: [
    { id: 'r1', displayName: 'Controller', portfolioId: 'p1', portfolioName: 'Finance roles', hasAccountable: true },
    { id: 'r2', displayName: 'Payroll clerk', portfolioId: 'p1', portfolioName: 'Finance roles', hasAccountable: false },
    { id: 'r4', displayName: 'Loose role', portfolioId: null, portfolioName: null, hasAccountable: true },
  ],
  portfolios: [{ id: 'p1', displayName: 'Finance roles', roleCount: 2 }],
};

function mount({ campaigns = [CAMPAIGN, PLANNED], askedCanOpen = true, detail = DETAIL, failList = false, postError = null, actionError = null, failDetail = false, failOptions = false } = {}) {
  const calls = [];
  const state = { campaigns, detail };
  const authFetch = makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    if (method !== 'GET') calls.push([method, u, opts.body ? JSON.parse(opts.body) : undefined]);
    if (u === '/api/review-campaigns/scope-options') return failOptions ? jsonResponse({ error: 'down' }, { ok: false, status: 500 }) : OPTIONS;
    if (u === '/api/review-campaigns' && method === 'POST') {
      if (postError) return jsonResponse({ error: postError }, { ok: false, status: 400 });
      state.campaigns = [{ ...CAMPAIGN, id: 'c-new', name: 'Brand new' }, ...state.campaigns];
      state.detail = { ...DETAIL, id: 'c-new', name: 'Brand new' };
      return jsonResponse(state.detail, { status: 201 });
    }
    if (u === '/api/review-campaigns') return failList ? jsonResponse({ error: 'down' }, { ok: false, status: 500 }) : { campaigns: state.campaigns, askedCanOpen };
    if (actionError && method !== 'GET') return jsonResponse({ error: actionError }, { ok: false, status: 404 });
    if (u.endsWith('/end')) { state.detail = { ...state.detail, status: 'ended', endedAt: '2026-12-05T09:00:00Z', nextRoundOn: null }; return state.detail; }
    if (method === 'DELETE') { state.campaigns = state.campaigns.filter(c => !u.endsWith(`/${c.id}`)); return jsonResponse(null, { status: 204 }); }
    if (u.startsWith('/api/review-campaigns/')) return failDetail ? jsonResponse({ error: 'down' }, { ok: false, status: 500 }) : state.detail;
    return undefined;
  });
  renderWithProviders(h(ReviewCampaignsTab), { auth: { authFetch } });
  return { calls, user: userEvent.setup() };
}

const openDetail = async (user) => {
  await user.click(await screen.findByRole('button', { name: 'Yearly finance review' }));
  return screen.findByTestId('campaign-detail');
};

describe('the list of campaigns', () => {
  it('shows each campaign with what it asks, how often, its round and how it stands', async () => {
    mount();
    const table = await screen.findByRole('table', { name: 'Review campaigns' });
    const [, running, planned] = within(table).getAllByRole('row');
    expect(running).toHaveTextContent('Yearly finance review');
    expect(running).toHaveTextContent('Who answers for it · Permissions');
    expect(running).toHaveTextContent('Running');
    expect(running).toHaveTextContent('1 role portfolio, 1 business role');
    expect(running).toHaveTextContent('Every year');
    expect(running).toHaveTextContent('Round 1, due');
    expect(running).toHaveTextContent('1 of 2 reviewed');
    expect(running).toHaveTextContent('1 with nobody Accountable');
    expect(planned).toHaveTextContent('Planned');
    expect(planned).toHaveTextContent('Once');
    expect(planned).toHaveTextContent('Starts');
    expect(planned).toHaveTextContent('Not started');
    expect(planned).not.toHaveTextContent('nobody Accountable');
  });

  it('says so when there are none, and when they cannot be loaded', async () => {
    mount({ campaigns: [] });
    expect(await screen.findByText(/There are no review campaigns yet/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says so when the campaigns cannot be loaded', async () => {
    mount({ failList: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('The review campaigns could not be loaded');
  });
});

describe('a new campaign', () => {
  const startNew = async (user) => {
    await user.click(await screen.findByRole('button', { name: 'New campaign' }));
    return screen.findByRole('form', { name: 'New review campaign' });
  };

  it('asks the steps, the scope and the schedule, and saves them', async () => {
    const { calls, user } = mount();
    const formEl = await startNew(user);
    const save = within(formEl).getByRole('button', { name: 'Start the campaign' });
    expect(save).toBeDisabled();
    expect(within(formEl).getByText('Give the campaign a name')).toBeInTheDocument();
    await user.type(within(formEl).getByLabelText('Name'), 'Finance check');
    expect(within(formEl).getByText('Choose at least one business role or role portfolio')).toBeInTheDocument();

    // Step 2 off; a whole portfolio and one loose role.
    await user.click(within(formEl).getByRole('checkbox', { name: /2\. Lifecycle/ }));
    await user.click(within(within(formEl).getByRole('list', { name: 'Role portfolios' })).getByRole('checkbox', { name: /Finance roles/ }));
    const roles = within(within(formEl).getByRole('list', { name: 'Business roles' }));
    expect(roles.getByRole('checkbox', { name: /Controller/ })).toBeChecked();
    expect(roles.getByRole('checkbox', { name: /Controller/ })).toBeDisabled();
    expect(roles.getByRole('checkbox', { name: /Payroll clerk/ }).closest('label')).toHaveTextContent('No Accountable');
    await user.click(roles.getByRole('checkbox', { name: /Loose role/ }));
    expect(within(formEl).getByTestId('scope-summary')).toHaveTextContent('3 business roles in scope now. 1 has nobody Accountable and falls outside the campaign: nobody is asked.');

    await user.click(within(formEl).getByRole('radio', { name: 'On a schedule' }));
    await user.selectOptions(within(formEl).getByLabelText('Repeat'), 'Every quarter');
    const days = within(formEl).getByLabelText('Days to do the review');
    await user.clear(days);
    await user.type(days, '14');
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(calls).toHaveLength(1));
    const [method, url, body] = calls[0];
    expect([method, url]).toEqual(['POST', '/api/review-campaigns']);
    expect(body).toMatchObject({ name: 'Finance check', steps: ['ownership', 'contents'], portfolioIds: ['p1'], roleIds: ['r4'], intervalMonths: 3, dueDays: 14 });
    expect(body.startsOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Lands on the new campaign.
    expect(await screen.findByRole('heading', { name: 'Brand new' })).toBeInTheDocument();
  });

  it('has no interval to choose while it asks once, and narrows the roles by search', async () => {
    const { user } = mount();
    const formEl = await startNew(user);
    expect(within(formEl).queryByLabelText('Repeat')).toBeNull();
    expect(within(formEl).getByLabelText('Starts on')).toBeInTheDocument();
    expect(within(formEl).getByTestId('scope-summary')).toHaveTextContent('0 business roles in scope now.');
    await user.type(within(formEl).getByLabelText('Business roles one by one'), 'clerk');
    expect(within(within(formEl).getByRole('list', { name: 'Business roles' })).getAllByRole('checkbox')).toHaveLength(1);
    await user.type(within(formEl).getByLabelText('Business roles one by one'), 'zzz');
    expect(within(formEl).getByText('No business role matches.')).toBeInTheDocument();
  });

  it('shows the API error and keeps the form', async () => {
    const { user } = mount({ postError: 'None of the chosen business roles or role portfolios exist any more' });
    const formEl = await startNew(user);
    await user.type(within(formEl).getByLabelText('Name'), 'Finance check');
    await user.click(within(within(formEl).getByRole('list', { name: 'Business roles' })).getByRole('checkbox', { name: /Loose role/ }));
    await user.click(within(formEl).getByRole('button', { name: 'Start the campaign' }));
    expect(await within(formEl).findByRole('alert')).toHaveTextContent('None of the chosen');
    expect(within(formEl).getByLabelText('Name')).toHaveValue('Finance check');
  });

  it('goes back to the list on Cancel without saving', async () => {
    const { calls, user } = mount();
    const formEl = await startNew(user);
    await user.click(within(formEl).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('table', { name: 'Review campaigns' })).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('says so when the roles to choose from cannot be loaded', async () => {
    const { user } = mount({ failOptions: true });
    await user.click(await screen.findByRole('button', { name: 'New campaign' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The business roles could not be loaded');
  });
});

describe('one campaign', () => {
  it('shows what it asks and how each role stands, with the roles nobody can be asked about apart', async () => {
    const { user } = mount();
    const detail = await openDetail(user);
    expect(detail).toHaveTextContent('Who answers for it · Permissions');
    expect(detail).toHaveTextContent('The Accountable of each role');
    expect(detail).toHaveTextContent('Every year, 30 days per round');
    expect(detail).toHaveTextContent('1 of 2 reviewed');
    expect(detail).toHaveTextContent('Finance roles (portfolio), Loose role');

    const outside = within(detail).getByRole('region', { name: 'Outside the campaign' });
    expect(outside).toHaveTextContent('Outside the campaign: 1 role has nobody Accountable');
    expect(outside).toHaveTextContent('Payroll clerk');

    const asked = within(detail).getByRole('table', { name: 'Roles asked' });
    expect(asked).not.toHaveTextContent('Payroll clerk');
    const [, controller, loose] = within(asked).getAllByRole('row');
    expect(controller).toHaveTextContent('Controller');
    expect(controller).toHaveTextContent('Reviewed, with findings');
    expect(controller).toHaveTextContent('Carla Cash ·');
    expect(loose).toHaveTextContent('Bob Builder');
    expect(loose).toHaveTextContent('Waiting');
    expect(within(detail).queryByRole('alert')).toBeNull();
  });

  it('warns when the Accountable cannot open their role', async () => {
    const { user } = mount({ askedCanOpen: false });
    const detail = await openDetail(user);
    expect(within(detail).getByRole('alert')).toHaveTextContent('cannot open their business roles yet');
  });

  it('says so for a campaign that has not asked yet, and for a round that had nothing in scope', async () => {
    const { user } = mount({ detail: { ...DETAIL, status: 'planned', round: null, requests: [] } });
    const detail = await openDetail(user);
    expect(detail).toHaveTextContent('Nobody is asked yet: the first round starts on');
    expect(within(detail).queryByRole('table')).toBeNull();
    expect(detail).not.toHaveTextContent('This round asked about no role');
  });

  it('says so for a round that asked about no role', async () => {
    const { user } = mount({ detail: { ...DETAIL, requests: [] } });
    expect(await openDetail(user)).toHaveTextContent('This round asked about no role');
  });

  it('ends a campaign only after asking once more', async () => {
    const { calls, user } = mount();
    const detail = await openDetail(user);
    await user.click(within(detail).getByRole('button', { name: 'End the campaign' }));
    expect(calls).toEqual([]);
    await user.click(within(detail).getByRole('button', { name: 'Keep it' }));
    await user.click(within(detail).getByRole('button', { name: 'End the campaign' }));
    await user.click(within(detail).getByRole('button', { name: 'Yes, stop asking' }));
    await waitFor(() => expect(calls).toEqual([['POST', `/api/review-campaigns/${ID}/end`, undefined]]));
    expect(await within(detail).findByText(/Ended on/)).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'End the campaign' })).toBeNull();
  });

  it('deletes a campaign and returns to the list without it', async () => {
    const { calls, user } = mount();
    const detail = await openDetail(user);
    await user.click(within(detail).getByRole('button', { name: 'Delete' }));
    await user.click(within(detail).getByRole('button', { name: 'Yes, delete it' }));
    await waitFor(() => expect(calls).toEqual([['DELETE', `/api/review-campaigns/${ID}`, undefined]]));
    const table = await screen.findByRole('table', { name: 'Review campaigns' });
    await waitFor(() => expect(table).not.toHaveTextContent('Yearly finance review'));
  });

  it('shows why an action did not work and stays on the campaign', async () => {
    const { user } = mount({ actionError: 'No running review campaign with this id' });
    const detail = await openDetail(user);
    await user.click(within(detail).getByRole('button', { name: 'End the campaign' }));
    await user.click(within(detail).getByRole('button', { name: 'Yes, stop asking' }));
    expect(await within(detail).findByRole('alert')).toHaveTextContent('No running review campaign with this id');
  });

  it('says so when the campaign cannot be loaded, and goes back to the list', async () => {
    const { user } = mount({ failDetail: true });
    await user.click(await screen.findByRole('button', { name: 'Yearly finance review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The campaign could not be loaded.');
    await user.click(screen.getByRole('button', { name: '← All campaigns' }));
    expect(await screen.findByRole('table', { name: 'Review campaigns' })).toBeInTheDocument();
  });
});
