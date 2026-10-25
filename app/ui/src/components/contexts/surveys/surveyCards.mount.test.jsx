// @vitest-environment jsdom
// The two survey cards on a context's page: sending a survey (and the ones
// sent), and the unit's roster.
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent, within } from '@ui/test-utils/renderWithProviders';
import { ClaimsContext } from '@ui/components/contexts/interviews/claimsContext';
import SendSurveyCard, { LISTED } from './SendSurveyCard';
import RosterCard from './RosterCard';

const CTX = { id: 'c-1', displayName: 'Team Innovation', contextCategory: 'OrganizationalUnit', targetType: 'Identity' };
const REQ = 'ffffffff-0000-4000-8000-000000000001';
const sentRow = (over = {}) => ({ id: REQ, templateName: 'Unit roster', recipientName: 'Teije', status: 'sent', sentAt: '2026-10-20T10:00:00Z', ...over });

function mountSend(handler, claims = { canWrite: true }) {
  const authFetch = makeAuthFetch(handler);
  renderWithProviders(<ClaimsContext.Provider value={claims}><SendSurveyCard attrs={CTX} /></ClaimsContext.Provider>, { auth: { authFetch } });
  return { authFetch, user: userEvent.setup() };
}

describe('SendSurveyCard', () => {
  it('a reader gets no card', () => {
    const { authFetch } = mountSend({}, { canWrite: false });
    expect(screen.queryByTestId('action-send-survey')).not.toBeInTheDocument();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('lists the surveys sent, links each, and withdraws one after asking', async () => {
    let rows = [sentRow(), sentRow({ id: 'r2', recipientName: 'Nina', status: 'submitted' })];
    const { authFetch, user } = mountSend((url, opts = {}) => {
      if (url === `/api/contexts/${CTX.id}/surveys`) return { data: rows };
      if (opts.method === 'DELETE') { rows = [sentRow({ status: 'cancelled' })]; return jsonResponse({}, { status: 204 }); }
      return undefined;
    });
    const list = await screen.findByRole('list', { name: 'Surveys' });
    expect(within(list).getByRole('link', { name: 'Teije' })).toHaveAttribute('href', `#surveys?request=${REQ}`);
    expect(within(list).getByText('answered')).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Withdraw the survey sent to Nina' })).not.toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Withdraw the survey sent to Teije' }));
    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(`/api/surveys/requests/${REQ}`, { method: 'DELETE' }));
    expect(await screen.findByText('withdrawn')).toBeInTheDocument();
  });

  it('shows at most a handful and counts the rest', async () => {
    mountSend({ [`/api/contexts/${CTX.id}/surveys`]: { data: Array.from({ length: LISTED + 2 }, (_, i) => sentRow({ id: `r${i}`, recipientName: `P${i}` })) } });
    expect(await screen.findByText('and 2 more')).toBeInTheDocument();
  });

  it('sends a chosen template to the Accountable, down the tree, with a due date', async () => {
    const { authFetch, user } = mountSend((url, opts = {}) => {
      if (url === `/api/contexts/${CTX.id}/surveys` && opts.method === 'POST') return { sent: [{ recipientName: 'Teije' }, { recipientName: 'Nina' }], skipped: [{ contextName: 'Interns' }] };
      if (url === `/api/contexts/${CTX.id}/surveys`) return { data: [] };
      if (url === `/api/surveys/templates?contextId=${CTX.id}`) return { data: [{ id: 't1', name: 'Customer check' }, { id: 't2', name: 'Unit roster' }] };
      return undefined;
    });
    await user.click(screen.getByRole('button', { name: 'Send survey' }));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Survey' }), 't2');
    await user.click(screen.getByRole('checkbox', { name: /every unit below/ }));
    await user.type(screen.getByLabelText('Answer before'), '2026-11-01');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Sent 2 surveys. Skipped 1 without an Accountable: Interns.')).toBeInTheDocument();
    const [, init] = authFetch.mock.calls.find(([u, o]) => u === `/api/contexts/${CTX.id}/surveys` && o?.method === 'POST');
    expect(JSON.parse(init.body)).toEqual({ templateId: 't2', toAccountable: true, includeSubContexts: true, dueAt: '2026-11-01' });
  });

  it('to someone else: Send waits for a person; a refusal is shown', async () => {
    const { user } = mountSend((url, opts = {}) => {
      if (url.startsWith('/api/users?search=Ni')) return { data: [{ id: 'p-nina', displayName: 'Nina' }] };
      if (url === `/api/contexts/${CTX.id}/surveys` && opts.method === 'POST') return jsonResponse({ error: 'The recipient was not found.' }, { ok: false, status: 404 });
      if (url === `/api/contexts/${CTX.id}/surveys`) return { data: [] };
      if (url.startsWith('/api/surveys/templates')) return { data: [{ id: 't1', name: 'Customer check' }] };
      return undefined;
    });
    await user.click(screen.getByRole('button', { name: 'Send survey' }));
    await screen.findByRole('combobox', { name: 'Survey' });
    await user.click(screen.getByRole('radio', { name: 'Someone else' }));
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Who receives it' }), 'Ni');
    await user.click(await screen.findByRole('button', { name: 'Nina' }));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('The recipient was not found.')).toBeInTheDocument();
  });

  it('says when no template applies', async () => {
    const { user } = mountSend({ [`/api/contexts/${CTX.id}/surveys`]: { data: [] }, '/api/surveys/templates': { data: [] } });
    await user.click(screen.getByRole('button', { name: 'Send survey' }));
    expect(await screen.findByText(/No survey template applies here yet/)).toBeInTheDocument();
  });
});

describe('RosterCard', () => {
  it('shows the unit\'s people coloured by what the claims say', async () => {
    const claims = [
      { claimKind: 'membership', subjectKind: 'Person', identityId: 'i-kim', attribute: 'current', status: 'confirmed' },
      { claimKind: 'role', subjectKind: 'Person', identityId: 'i-kim', attribute: 'member', value: 'Data scientist', status: 'confirmed' },
      { claimKind: 'membership', subjectKind: 'Person', identityId: 'i-tom', attribute: 'left', status: 'proposed' },
    ];
    const authFetch = makeAuthFetch({ [`/api/contexts/${CTX.id}/members?limit=500`]: { data: [
      { id: 'i-kim', displayName: 'Kim Los', jobTitle: 'Analyst', department: 'Innovation' },
      { id: 'i-tom', displayName: 'Thom Oskam' },
      { id: 'i-ann', displayName: 'Ann Akker' },
    ] } });
    renderWithProviders(<ClaimsContext.Provider value={{ claims }}><RosterCard attrs={CTX} /></ClaimsContext.Provider>, { auth: { authFetch } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'View roster' }));
    expect(await screen.findByText('Roster: Team Innovation')).toBeInTheDocument();
    const dialog = document.body;
    const kim = (await within(dialog).findByText('Kim Los')).closest('tr');
    expect(kim).toHaveAttribute('data-state', 'here');
    expect(kim).toHaveTextContent('Data scientist');
    expect(kim.className).not.toMatch(/italic/);
    const tom = within(dialog).getByText('Thom Oskam').closest('tr');
    expect(tom).toHaveAttribute('data-state', 'gone');
    expect(tom.className).toMatch(/italic/);
    expect(within(dialog).getByText('Ann Akker').closest('tr')).toHaveAttribute('data-state', 'unknown');
    expect(within(dialog).getByText('Works here (1)')).toBeInTheDocument();
  });
});
