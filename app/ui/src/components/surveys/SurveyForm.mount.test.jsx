// @vitest-environment jsdom
// Answering a survey, mounted: the form opens branches as it is answered,
// asks per row with a bulk answer, saves a draft, submits the answers, and
// opens read-only once answered.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent, within } from '@ui/test-utils/renderWithProviders';
import SurveyForm, { SurveyPreview, SAVE_DELAY_MS } from './SurveyForm';

const REQ = 'ffffffff-0000-4000-8000-000000000001';
const definition = {
  schemaVersion: 1,
  languages: ['en', 'nl'],
  title: { en: 'Intake: {context}', nl: 'Intake: {context}' },
  intro: 'Questions about {context}.',
  sections: [
    { id: 'own', title: 'Ownership', questions: [
      { id: 'isOwner', text: { en: 'Are you the owner of {context}?', nl: 'Bent u de eigenaar van {context}?' }, required: true, answer: { type: 'yesNo' } },
      { id: 'who', text: 'Who is, then?', showWhen: { question: 'isOwner', equals: 'no' }, answer: { type: 'person' } },
      { id: 'crit', text: 'How critical?', help: 'A is most critical.', answer: { type: 'choice', options: [{ value: 'A', label: 'A: stops' }, { value: 'B', label: 'B: hurts' }] } },
    ] },
    { id: 'team', title: 'People', questions: [
      { id: 'works', text: 'Works for you?', required: true, rows: { source: 'members', columns: ['displayName', 'jobTitle'] }, answer: { type: 'yesNo' } },
    ] },
  ],
};
const rows = { works: [
  { id: 'r1', displayName: 'Kim Los', columns: { displayName: 'Kim Los', jobTitle: 'Analyst' } },
  { id: 'r2', displayName: 'Tom Oskam', columns: { displayName: 'Tom Oskam', jobTitle: 'Intern' } },
] };
const request = (over = {}) => ({
  id: REQ, definition, rows, answers: {}, status: 'sent', asRecipient: true, contextName: 'Payroll', recipientName: 'Anna',
  language: null, dueAt: '2026-11-01', message: 'Graag voor vrijdag', contextValues: {}, ...over,
});

function mount(req = request(), submitReply = { interviewId: 'iv', claims: 3 }) {
  const authFetch = makeAuthFetch((url, opts = {}) => {
    if (url === `/api/surveys/requests/${REQ}`) return req;
    if (url.endsWith('/answers') && opts.method === 'PUT') return { answers: {} };
    if (url.endsWith('/submit') && opts.method === 'POST') return submitReply;
    return undefined;
  });
  const onDone = vi.fn();
  renderWithProviders(<SurveyForm requestId={REQ} onDone={onDone} />, { auth: { authFetch } });
  return { authFetch, onDone, user: userEvent.setup() };
}
const bodyOf = (authFetch, suffix) => JSON.parse(authFetch.mock.calls.find(([u, o]) => u.endsWith(suffix) && o?.method)[1].body);

afterEach(() => vi.useRealTimers());

describe('SurveyForm', () => {
  it('shows the survey in the respondent\'s words with the context filled in, the message and the progress', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'Intake: Payroll' })).toBeInTheDocument();
    expect(screen.getByText('Questions about Payroll.')).toBeInTheDocument();
    expect(screen.getByText('Graag voor vrijdag')).toBeInTheDocument();
    expect(screen.getByText(/0 of 3 answered/)).toBeInTheDocument();
    expect(screen.getByText('A is most critical.')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Job title' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Intern' })).toBeInTheDocument();
    expect(screen.queryByTestId('on-behalf')).not.toBeInTheDocument();
  });

  it('opens the follow-up question only on "No"', async () => {
    const { user } = mount();
    const owner = await screen.findByRole('radiogroup', { name: 'Are you the owner of Payroll?' });
    expect(screen.queryByTestId('question-who')).not.toBeInTheDocument();
    await user.click(within(owner).getByRole('radio', { name: 'No' }));
    expect(screen.getByTestId('question-who')).toBeInTheDocument();
    await user.click(within(owner).getByRole('radio', { name: 'Yes' }));
    expect(screen.queryByTestId('question-who')).not.toBeInTheDocument();
  });

  it('switches language, and "All yes" answers every open row; submit sends the answers and the language', async () => {
    const { authFetch, onDone, user } = mount();
    await user.click(await screen.findByRole('button', { name: 'nl' }));
    const owner = screen.getByRole('radiogroup', { name: 'Bent u de eigenaar van Payroll?' });
    await user.click(within(owner).getByRole('radio', { name: 'Ja' }));
    await user.click(within(screen.getByRole('radiogroup', { name: 'Works for you? (Tom Oskam)' })).getByRole('radio', { name: 'Nee' }));
    await user.click(screen.getByRole('button', { name: 'Allemaal ja' }));
    await user.click(within(screen.getByRole('radiogroup', { name: 'How critical?' })).getByRole('radio', { name: 'B: hurts' }));
    expect(screen.getByText(/3 van 3 beantwoord/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Versturen' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(bodyOf(authFetch, '/submit')).toEqual({ answers: { isOwner: 'yes', works: { r2: 'no', r1: 'yes' }, crit: 'B' }, language: 'nl' });
  });

  it('shows what the API says is missing, by question text', async () => {
    const authFetch = makeAuthFetch((url, opts = {}) => {
      if (url === `/api/surveys/requests/${REQ}`) return request();
      if (url.endsWith('/submit')) return jsonResponse({ error: 'Some answers are missing', details: { errors: [{ question: 'isOwner', message: 'needs an answer' }] } }, { ok: false, status: 400 });
      return opts.method === 'PUT' ? {} : undefined;
    });
    renderWithProviders(<SurveyForm requestId={REQ} />, { auth: { authFetch } });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Submit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Are you the owner of Payroll?: needs an answer');
  });

  it('saves a draft a moment after a change, not on opening', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { authFetch } = mount(request({ answers: { crit: 'A' } }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const owner = await screen.findByRole('radiogroup', { name: 'Are you the owner of Payroll?' });
    vi.advanceTimersByTime(SAVE_DELAY_MS * 2);
    expect(authFetch.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(false);
    await user.click(within(owner).getByRole('radio', { name: 'Yes' }));
    vi.advanceTimersByTime(SAVE_DELAY_MS + 10);
    await waitFor(() => expect(authFetch.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(true));
    expect(bodyOf(authFetch, '/answers')).toEqual({ answers: { crit: 'A', isOwner: 'yes' } });
    expect(await screen.findByText('Draft saved')).toBeInTheDocument();
  });

  it('tells an analyst they answer on the recipient\'s behalf', async () => {
    mount(request({ asRecipient: false }));
    expect(await screen.findByTestId('on-behalf')).toHaveTextContent('on behalf of Anna');
  });

  it('opens an answered survey read-only, without submit', async () => {
    mount(request({ status: 'submitted', submittedAt: '2026-10-20T10:00:00Z', answers: { isOwner: 'yes' } }));
    expect(await screen.findByTestId('survey-closed')).toHaveTextContent(/^Answered on/);
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Yes', checked: true })).toBeDisabled();
  });

  it('says so when the survey was sent to someone else', async () => {
    const authFetch = makeAuthFetch(() => jsonResponse({ error: 'x' }, { ok: false, status: 403 }));
    renderWithProviders(<SurveyForm requestId={REQ} />, { auth: { authFetch } });
    expect(await screen.findByRole('alert')).toHaveTextContent('This survey was sent to someone else.');
  });

  it('a preview is answerable but saves nothing and has no submit', async () => {
    const authFetch = makeAuthFetch({});
    renderWithProviders(<SurveyPreview definition={definition} />, { auth: { authFetch } });
    const user = userEvent.setup();
    await user.click(within(screen.getByRole('radiogroup', { name: 'Are you the owner of Example?' })).getByRole('radio', { name: 'No' }));
    expect(screen.getByTestId('question-who')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
    expect(authFetch).not.toHaveBeenCalled();
  });
});
