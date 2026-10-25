// @vitest-environment jsdom
// Do survey: answering a survey about this context here and now, nothing sent.
// Who sees the button, what the dialog defaults to, when a respondent must be
// picked, what is posted, and that the form opens on the request made.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent, within } from '@ui/test-utils/renderWithProviders';
import { ClaimsContext } from '@ui/components/contexts/interviews/claimsContext';
import SendSurveyCard from './SendSurveyCard';
import DoSurveyCard from './DoSurveyCard';
import DoSurveyModal from './DoSurveyModal';

const CTX = { id: 'c-1', displayName: 'Team Innovation', contextCategory: 'OrganizationalUnit', targetType: 'Identity' };
const START = `/api/contexts/${CTX.id}/surveys/start`;
const REQ = 'ffffffff-0000-4000-8000-000000000001';
const TEMPLATES = [{ id: 't1', name: 'Customer check' }, { id: 't2', name: 'Unit roster' }];
const ME = { principalId: 'p-me', displayName: 'Sam Signed-in', email: 'sam@example.test' };

const options = (over = {}) => ({ allowed: true, pickRespondent: true, respondent: null, templates: TEMPLATES, ...over });
const posted = (authFetch) => {
  const call = authFetch.mock.calls.find(([u, o]) => u === START && o?.method === 'POST');
  return call ? JSON.parse(call[1].body) : null;
};

function mount(ui, handler, claims) {
  const authFetch = makeAuthFetch(handler);
  renderWithProviders(<ClaimsContext.Provider value={claims}>{ui}</ClaimsContext.Provider>, { auth: { authFetch } });
  return { authFetch, user: userEvent.setup() };
}

afterEach(() => { window.location.hash = ''; });

describe('who sees Do survey', () => {
  it('an analyst: on the survey card, next to Send survey, without asking the API first', () => {
    const { authFetch } = mount(<SendSurveyCard attrs={CTX} />, { [`/api/contexts/${CTX.id}/surveys`]: { data: [] } }, { canWrite: true });
    const card = screen.getByTestId('action-send-survey');
    expect(within(card).getByRole('button', { name: 'Do survey' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Send survey' })).toBeInTheDocument();
    expect(authFetch.mock.calls.some(([u]) => u === START)).toBe(false);
  });

  it('the separate card stays empty for an analyst — the survey card has it', () => {
    const { authFetch } = mount(<DoSurveyCard attrs={CTX} />, {}, { canWrite: true });
    expect(screen.queryByTestId('action-do-survey')).not.toBeInTheDocument();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('someone holding a role here (no analyst): the card, when the API allows it', async () => {
    mount(<DoSurveyCard attrs={CTX} />, { [START]: options({ pickRespondent: false, respondent: ME }) }, { canWrite: false });
    expect(await screen.findByTestId('action-do-survey')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Do survey' })).toBeInTheDocument();
  });

  it('a reader the API does not allow, or a failed check: no button', async () => {
    const { authFetch } = mount(<DoSurveyCard attrs={CTX} />, { [START]: { allowed: false, templates: [] } }, { canWrite: false });
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(START));
    expect(screen.queryByRole('button', { name: 'Do survey' })).not.toBeInTheDocument();
  });

  it('the survey card lists one done in place as in progress, then as answered in place', async () => {
    mount(<SendSurveyCard attrs={CTX} />, { [`/api/contexts/${CTX.id}/surveys`]: { data: [
      { id: 'r1', templateName: 'Unit roster', recipientName: 'Dana Example', status: 'sent', inPlace: true, sentAt: '2026-10-25T10:00:00Z' },
      { id: 'r2', templateName: 'Unit roster', recipientName: 'Lee Example', status: 'submitted', inPlace: true, sentAt: '2026-10-24T10:00:00Z' },
      { id: 'r3', templateName: 'Unit roster', recipientName: 'Kai Example', status: 'sent', sentAt: '2026-10-23T10:00:00Z' },
    ] } }, { canWrite: true });
    const list = await screen.findByRole('list', { name: 'Surveys' });
    expect(within(list).getByText('in progress')).toBeInTheDocument();
    expect(within(list).getByText('answered in place')).toBeInTheDocument();
    expect(within(list).getByText('waiting')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Lee Example' })).toHaveAttribute('title', 'Unit roster — answered in place by Lee Example');
    expect(within(list).getByRole('button', { name: 'Withdraw the survey started for Dana Example' })).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Withdraw the survey sent to Kai Example' })).toBeInTheDocument();
  });
});

describe('the Do survey dialog', () => {
  it('auth off: the first template by default, and Start waits until an account is picked', async () => {
    const openSurvey = vi.fn();
    const { authFetch, user } = mount(<DoSurveyModal contextId={CTX.id} onClose={() => {}} openSurvey={openSurvey} />, (url, opts = {}) => {
      if (url === START && opts.method === 'POST') return jsonResponse({ id: REQ, resumed: false, recipientName: 'Dana Example', onBehalf: true }, { status: 201 });
      if (url === START) return options();
      if (url.startsWith('/api/users?search=Da')) return { data: [{ id: 'p-dana', displayName: 'Dana Example', userPrincipalName: 'dana@example.test' }] };
      return undefined;
    }, { canWrite: true });
    expect(await screen.findByRole('combobox', { name: 'Survey' })).toHaveValue('t1');
    expect(screen.getByText(/Nobody is signed in/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'The account answering' }), 'Da');
    await user.click(await screen.findByRole('button', { name: /Dana Example/ }));
    expect(screen.getByText('dana@example.test')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(openSurvey).toHaveBeenCalledWith(REQ));
    expect(posted(authFetch)).toEqual({ templateId: 't1', principalId: 'p-dana' });
  });

  it('signed in: the caller answers by default (no account posted); another template may be chosen', async () => {
    const openSurvey = vi.fn();
    const { authFetch, user } = mount(<DoSurveyModal contextId={CTX.id} onClose={() => {}} openSurvey={openSurvey} />, (url, opts = {}) => {
      if (url === START && opts.method === 'POST') return jsonResponse({ id: REQ }, { status: 201 });
      if (url === START) return options({ respondent: ME });
      return undefined;
    }, { canWrite: true });
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Survey' }), 't2');
    expect(screen.getByText('Sam Signed-in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'change' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(openSurvey).toHaveBeenCalledWith(REQ));
    expect(posted(authFetch)).toEqual({ templateId: 't2' });
  });

  it('signed in, an analyst may change who answers to another account', async () => {
    const { authFetch, user } = mount(<DoSurveyModal contextId={CTX.id} onClose={() => {}} openSurvey={vi.fn()} />, (url, opts = {}) => {
      if (url === START && opts.method === 'POST') return jsonResponse({ id: REQ }, { status: 201 });
      if (url === START) return options({ respondent: ME });
      if (url.startsWith('/api/users?search=Le')) return { data: [{ id: 'p-lee', displayName: 'Lee Example', email: 'lee@example.test' }] };
      return undefined;
    }, { canWrite: true });
    await user.click(await screen.findByRole('button', { name: 'change' }));
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(screen.queryByText(/Nobody is signed in/)).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'The account answering' }), 'Le');
    await user.click(await screen.findByRole('button', { name: /Lee Example/ }));
    expect(screen.getByText('lee@example.test')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(posted(authFetch)).toEqual({ templateId: 't1', principalId: 'p-lee' }));
  });

  it('a role holder answers for themselves: no way to pick someone else', async () => {
    mount(<DoSurveyModal contextId={CTX.id} onClose={() => {}} openSurvey={vi.fn()} />, { [START]: options({ pickRespondent: false, respondent: ME }) }, { canWrite: false });
    expect(await screen.findByText('Sam Signed-in')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'change' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'The account answering' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled();
  });

  it('opens the survey form by its link by default; a refusal is shown and nothing opens', async () => {
    const { user } = mount(<DoSurveyCard attrs={CTX} />, (url, opts = {}) => {
      if (url === START && opts.method === 'POST') return jsonResponse({ id: REQ }, { status: 201 });
      if (url === START) return options({ pickRespondent: false, respondent: ME });
      return undefined;
    }, { canWrite: false });
    await user.click(await screen.findByRole('button', { name: 'Do survey' }));
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    await waitFor(() => expect(window.location.hash).toBe(`#surveys?request=${REQ}`));
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
  });

  it('a refusal from the API is shown', async () => {
    const openSurvey = vi.fn();
    const { user } = mount(<DoSurveyModal contextId={CTX.id} onClose={() => {}} openSurvey={openSurvey} />, (url, opts = {}) => {
      if (url === START && opts.method === 'POST') return jsonResponse({ error: 'You can do this survey for yourself only.' }, { ok: false, status: 403 });
      if (url === START) return options({ respondent: ME });
      return undefined;
    }, { canWrite: true });
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByText('You can do this survey for yourself only.')).toBeInTheDocument();
    expect(openSurvey).not.toHaveBeenCalled();
  });

  it('says when no template applies', async () => {
    mount(<DoSurveyModal contextId={CTX.id} onClose={() => {}} />, { [START]: options({ templates: [] }) }, { canWrite: true });
    expect(await screen.findByText(/No survey template applies here yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
  });
});
