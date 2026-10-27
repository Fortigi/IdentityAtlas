// @vitest-environment jsdom
// The forms around added sources: "Add information" (a file — a transcript, a
// csv or xlsx list — or pasted text, from someone or nobody in particular),
// adding a claim by hand with a quote taken from the text, the Sources list,
// and the "Mentioned in interviews" section of a person's page.
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import AddInformation from './AddInformation';
import { ACCEPT, INTRO } from './AddInformationModal';
import ManualClaimForm from './ManualClaimForm';
import SourcesList from './SourcesList';
import InterviewMentions from './InterviewMentions';
import { ClaimsContext } from './claimsContext';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, within, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';
// Organisation knowledge is behind a flag (off by default); these tests are about it.
vi.mock('@ui/hooks/useOrgKnowledge', () => ({ useOrgKnowledge: () => true }));

const TRANSCRIPT = 'Anna Voorbeeld: Yes, I am the owner of this app, but Piet does the day-to-day.';
const POST = '/api/contexts/c-app/interviews';

describe('Add information', () => {
  function mountButton({ answer = { id: 'iv-1', llmConfigured: true } } = {}) {
    const reload = vi.fn();
    const authFetch = makeAuthFetch((url, opts = {}) => {
      if (url === POST && opts.method === 'POST') return answer;
      if (String(url).startsWith('/api/users?search=ann')) return { data: [{ id: 'p-anna', displayName: 'Anna Voorbeeld' }] };
      if (String(url).startsWith('/api/users?')) return { data: [] };
      return undefined;
    });
    renderWithProviders(h(ClaimsContext.Provider, { value: { canWrite: true, reload } }, h(AddInformation, { contextId: 'c-app' })), { auth: { authFetch } });
    return { authFetch, reload, user: userEvent.setup() };
  }
  const posted = (authFetch) => authFetch.mock.calls.find(([u, o]) => u === POST && o?.method === 'POST')[1].body;

  it('opens "Add information" with what may be added, and takes transcripts, notes, Word, csv and xlsx files', async () => {
    const { user } = mountButton();
    await user.click(screen.getByRole('button', { name: 'Add information' }));
    expect(screen.getByRole('heading', { name: 'Add information' })).toBeInTheDocument();
    expect(screen.getByText(INTRO)).toBeInTheDocument();
    expect(INTRO).toBe('A transcript, notes, an Excel or CSV list, a Word document — anything that says something about this unit.');
    expect(screen.getByLabelText('File (.txt, .md, .docx, .vtt, .srt, .csv or .xlsx)')).toHaveAttribute('accept', ACCEPT);
    expect(ACCEPT.split(',')).toEqual(['.txt', '.md', '.docx', '.vtt', '.srt', '.csv', '.xlsx']);
  });

  it('a list from nobody in particular: the file and the date, no principalId; then refreshes and says so', async () => {
    const { authFetch, reload, user } = mountButton();
    await user.click(screen.getByRole('button', { name: 'Add information' }));
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    await user.upload(screen.getByLabelText(/^File/), new File(['Name;Role\nAnn;Architect'], 'team.csv', { type: 'text/csv' }));
    const date = screen.getByLabelText('Date');
    await user.clear(date);
    await user.type(date, '2026-10-02');
    await user.click(add);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    const body = posted(authFetch);
    expect([...body.keys()]).toEqual(['file', 'interviewedAt']);
    expect(body.get('file').name).toBe('team.csv');
    expect(body.get('interviewedAt')).toBe('2026-10-02');
    expect(await screen.findByText('Added. What it says appears for review once it is read.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Add information' })).toBeNull();
  });

  it('an xlsx from someone: "Who is this from?" sends that account', async () => {
    const { authFetch, user } = mountButton();
    await user.click(screen.getByRole('button', { name: 'Add information' }));
    await user.upload(screen.getByLabelText(/^File/), new File(['PK'], 'team.xlsx'));
    await user.type(screen.getByRole('textbox', { name: 'Who is this from? (optional)' }), 'ann');
    await user.click(await screen.findByRole('button', { name: 'Anna Voorbeeld' }));
    expect(screen.getByText(/^From:/)).toHaveTextContent('From: Anna Voorbeeld change');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(POST, expect.objectContaining({ method: 'POST' })));
    const body = posted(authFetch);
    expect([body.get('file').name, body.get('principalId')]).toEqual(['team.xlsx', 'p-anna']);
  });

  it('Paste text sends the text, never a file; blank text cannot be added', async () => {
    const { authFetch, user } = mountButton({ answer: { id: 'iv-2', llmConfigured: false } });
    await user.click(screen.getByRole('button', { name: 'Add information' }));
    await user.upload(screen.getByLabelText(/^File/), new File(['x'], 'ignored.txt'));
    await user.click(screen.getByRole('button', { name: 'Paste text' }));
    expect(screen.getByRole('button', { name: 'Paste text' })).toHaveAttribute('aria-pressed', 'true');
    const add = screen.getByRole('button', { name: 'Add' });
    await user.type(screen.getByRole('textbox', { name: 'Text' }), '   ');
    expect(add).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Text' }), 'Piet left in May.');
    await user.click(add);
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(POST, expect.objectContaining({ method: 'POST' })));
    const body = posted(authFetch);
    expect(body.get('file')).toBeNull();
    expect(body.get('text')).toBe('   Piet left in May.');
    expect(await screen.findByText('Added. No model is configured: add claims by hand under Sources.')).toBeInTheDocument();
  });

  it('without a date it cannot be added; a refusal stays in the modal', async () => {
    const { user } = mountButton({ answer: jsonResponse({ error: 'The transcript holds no text.' }, { ok: false, status: 400 }) });
    await user.click(screen.getByRole('button', { name: 'Add information' }));
    await user.upload(screen.getByLabelText(/^File/), new File([' '], 'empty.txt'));
    await user.clear(screen.getByLabelText('Date'));
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    await user.type(screen.getByLabelText('Date'), '2026-10-01');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('The transcript holds no text.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add information' })).toBeInTheDocument();
  });

  it('is not there for a reader, nor outside a ClaimsProvider', () => {
    renderWithProviders(h(ClaimsContext.Provider, { value: { canWrite: false } }, h(AddInformation, { contextId: 'c-app' })));
    renderWithProviders(h(AddInformation, { contextId: 'c-app' }));
    expect(screen.queryByRole('button', { name: 'Add information' })).toBeNull();
  });
});

describe('SourcesList', () => {
  const SOURCES = [
    { id: 'iv-1', sourceKind: 'interview', intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01', fileName: 'gesprek.vtt', extractionStatus: 'done', proposed: 4, confirmed: 2, extractionMessage: '1 claim was left out because the quote is not in the transcript.' },
    { id: 'iv-2', sourceKind: 'file', intervieweeName: 'analyst@example.test', interviewedAt: '2026-10-02', fileName: 'team.xlsx', extractionStatus: 'running', proposed: 0, confirmed: 0 },
    { id: 'iv-3', sourceKind: 'text', intervieweeName: 'analyst@example.test', interviewedAt: '2026-10-03', fileName: 'Pasted text', extractionStatus: 'notConfigured' },
  ];
  function mountList({ refuse = false } = {}) {
    const onChanged = vi.fn();
    const onViewTranscript = vi.fn();
    const authFetch = makeAuthFetch((url, opts = {}) => {
      if (opts.method === 'POST') return refuse ? jsonResponse({ error: 'This interview is being read right now.' }, { ok: false, status: 409 }) : jsonResponse({}, { status: 202 });
      if (opts.method === 'DELETE') return jsonResponse(undefined, { status: 204 });
      return undefined;
    });
    renderWithProviders(h(SourcesList, { contextId: 'c-app', interviews: SOURCES, onChanged, onViewTranscript }), { auth: { authFetch } });
    return { authFetch, onChanged, onViewTranscript, user: userEvent.setup(), rows: screen.getAllByTestId('source-row') };
  }

  it('one row per source: its kind, who it is from (or who added it), when, the file, how far it got, its counts', () => {
    const { rows } = mountList();
    expect(rows.map(r => r.firstChild.textContent)).toEqual(['Interview', 'File', 'Pasted text']);
    expect(rows[0]).toHaveTextContent('InterviewAnna Voorbeeld · 2026-10-01 · gesprek.vttRead4 to review · 2 confirmed');
    expect(rows[0]).toHaveTextContent('1 claim was left out because the quote is not in the transcript.');
    expect(rows[1]).toHaveTextContent('Fileadded by analyst@example.test · 2026-10-02 · team.xlsxReading…0 to review · 0 confirmed');
    // Pasted text has no file to name; no Read again without a model, nor while one reads.
    expect(rows[2]).toHaveTextContent('Pasted textadded by analyst@example.test · 2026-10-03No model configured — add claims by hand0 to review · 0 confirmed');
    expect(rows.map(r => !!within(r).queryByRole('button', { name: 'Read again' }))).toEqual([true, false, false]);
  });

  it('View opens the text; Read again asks the model and refreshes', async () => {
    const { authFetch, onChanged, onViewTranscript, user, rows } = mountList();
    await user.click(within(rows[1]).getByRole('button', { name: 'View the team.xlsx, 2026-10-02' }));
    expect(onViewTranscript).toHaveBeenCalledWith('iv-2');
    await user.click(within(rows[0]).getByRole('button', { name: 'Read again' }));
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/c-app/interviews/iv-1/extract', { method: 'POST' });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('a refused Read again shows the API sentence and changes nothing', async () => {
    const { onChanged, user, rows } = mountList({ refuse: true });
    await user.click(within(rows[0]).getByRole('button', { name: 'Read again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This interview is being read right now.');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('Delete asks first, naming the source, then deletes it', async () => {
    const { authFetch, onChanged, user, rows } = mountList();
    await user.click(within(rows[2]).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Delete the notes added by analyst@example.test, 2026-10-03 and the claims it made? What confirmed claims already changed stays.')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1));
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/contexts/c-app/interviews/iv-3', { method: 'DELETE' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('says so when nothing was added', () => {
    renderWithProviders(h(SourcesList, { contextId: 'c-app', interviews: [], onChanged: vi.fn() }));
    expect(screen.getByText('Nothing added yet.')).toBeInTheDocument();
  });
});

describe('ManualClaimForm', () => {
  function mountForm(interview = { id: 'iv-1', intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01' }) {
    const onAdded = vi.fn();
    const onClose = vi.fn();
    const authFetch = makeAuthFetch((url, opts = {}) => {
      if (url === '/api/contexts/c-app/interviews/iv-1/claims' && opts.method === 'POST') return jsonResponse({ id: 'new' }, { status: 201 });
      if (url === '/api/contexts/c-app/interviews/iv-1') return { id: 'iv-1', transcript: TRANSCRIPT };
      return undefined;
    });
    renderWithProviders(h(ManualClaimForm, { contextId: 'c-app', interview, onAdded, onClose }), { auth: { authFetch } });
    return { authFetch, onAdded, onClose, user: userEvent.setup() };
  }

  it('names its source: an interview by who and when', () => {
    mountForm();
    expect(screen.getByText('From the interview with Anna Voorbeeld, 2026-10-01')).toBeInTheDocument();
  });

  it('a list source is named by its file', () => {
    mountForm({ id: 'iv-1', sourceKind: 'file', fileName: 'team.xlsx', intervieweeName: 'u', interviewedAt: '2026-10-02' });
    expect(screen.getByText('From the team.xlsx, 2026-10-02')).toBeInTheDocument();
  });

  it('takes the selected words of the transcript as the quote and posts a role claim', async () => {
    const { authFetch, onAdded, onClose, user } = mountForm();
    const transcript = screen.getByRole('textbox', { name: 'Transcript' });
    await waitFor(() => expect(transcript).toHaveValue(TRANSCRIPT));
    const start = TRANSCRIPT.indexOf('Piet does');
    transcript.setSelectionRange(start, start + 'Piet does the day-to-day'.length);
    await user.click(screen.getByRole('button', { name: 'Use the selection as quote' }));
    expect(screen.getByRole('textbox', { name: 'Quote' })).toHaveValue('Piet does the day-to-day');
    const add = screen.getByRole('button', { name: 'Add claim' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'role');
    await user.type(screen.getByRole('textbox', { name: 'What it says' }), 'does the day-to-day');
    expect(add).toBeDisabled(); // a role claim needs its person
    await user.type(screen.getByRole('textbox', { name: 'Person' }), 'Piet');
    await user.selectOptions(screen.getByRole('combobox', { name: 'What they are to it' }), 'dayToDay');
    await user.click(add);
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    const [, init] = authFetch.mock.calls.find(([, o]) => o?.method === 'POST');
    expect(JSON.parse(init.body)).toEqual({ kind: 'role', value: 'does the day-to-day', subject: 'Piet', relation: 'dayToDay', quote: 'Piet does the day-to-day' });
    expect(onClose).toHaveBeenCalled();
  });

  it('a membership claim asks whether the person is in it now, and sends that status', async () => {
    const { authFetch, onAdded, user } = mountForm();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'membership');
    expect(screen.queryByRole('combobox', { name: 'What they are to it' })).toBeNull();
    const status = screen.getByRole('combobox', { name: 'In it now?' });
    expect([...status.options].map(o => o.textContent)).toEqual(['current member', 'former member', 'joined', 'left', 'back again (rejoined)']);
    await user.selectOptions(status, 'former');
    await user.type(screen.getByRole('textbox', { name: 'Person' }), 'Karel');
    await user.type(screen.getByRole('textbox', { name: 'What it says' }), 'worked on it before');
    await user.click(screen.getByRole('button', { name: 'Add claim' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    const [, init] = authFetch.mock.calls.find(([, o]) => o?.method === 'POST');
    expect(JSON.parse(init.body)).toEqual({ kind: 'membership', value: 'worked on it before', subject: 'Karel', membership: 'former' });
  });

  it('an empty selection changes nothing', async () => {
    const { user } = mountForm();
    await user.type(screen.getByRole('textbox', { name: 'Quote' }), 'typed');
    await user.click(screen.getByRole('button', { name: 'Use the selection as quote' }));
    expect(screen.getByRole('textbox', { name: 'Quote' })).toHaveValue('typed');
  });
});

describe('InterviewMentions', () => {
  it('links each context that mentions the person, with its claims and latest interview', async () => {
    const onOpenDetail = vi.fn();
    const authFetch = makeAuthFetch({ '/api/contexts/claims/mentions?identityId=i-1': { data: [{ contextId: 'c-app', contextName: 'Planner', claims: 1, lastInterviewedAt: '2026-10-01' }, { contextId: 'c-acme', contextName: 'Acme', claims: 3, lastInterviewedAt: '2026-09-02' }] } });
    renderWithProviders(h(InterviewMentions, { holder: { identityId: 'i-1' }, onOpenDetail }), { auth: { authFetch } });
    const section = await screen.findByRole('region', { name: 'Mentioned in interviews' });
    expect(within(section).getAllByRole('listitem').map(li => li.textContent)).toEqual(['Planner · 1 claim · last interview 2026-10-01', 'Acme · 3 claims · last interview 2026-09-02']);
    await userEvent.setup().click(within(section).getByRole('button', { name: 'Acme' }));
    expect(onOpenDetail).toHaveBeenCalledWith('context', 'c-acme', 'Acme');
  });

  it('shows nothing for a person no interview mentions, and asks nothing without a holder', async () => {
    const authFetch = makeAuthFetch({ '/api/contexts/claims/mentions': { data: [] } });
    renderWithProviders(h(InterviewMentions, { holder: { principalId: 'p-1' } }), { auth: { authFetch } });
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/contexts/claims/mentions?principalId=p-1'));
    expect(screen.queryByRole('region', { name: 'Mentioned in interviews' })).toBeNull();
    const none = makeAuthFetch({});
    renderWithProviders(h(InterviewMentions, { holder: {} }), { auth: { authFetch: none } });
    expect(none).not.toHaveBeenCalled();
  });
});
