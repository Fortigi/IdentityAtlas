// @vitest-environment jsdom
// The forms around context interviews: uploading a transcript (the card and its
// modal), adding a claim by hand with a quote taken from the transcript, the
// "Mentioned in interviews" section of a person's page and the role timeline.
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import UploadInterviewCard from './UploadInterviewCard';
import ManualClaimForm from './ManualClaimForm';
import InterviewMentions from './InterviewMentions';
import RoleTimeline from './RoleTimeline';
import { ClaimsContext } from './claimsContext';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, within, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const APP = { id: 'c-app', contextCategory: 'LogicalApplication' };
const TRANSCRIPT = 'Anna Voorbeeld: Yes, I am the owner of this app, but Piet does the day-to-day.';

describe('UploadInterviewCard', () => {
  function mountCard({ answer = { id: 'iv-1', llmConfigured: true } } = {}) {
    const reload = vi.fn();
    const authFetch = makeAuthFetch((url, opts = {}) => {
      if (url === '/api/contexts/c-app/interviews' && opts.method === 'POST') return answer;
      if (String(url).startsWith('/api/users?search=ann')) return { data: [{ id: 'p-anna', displayName: 'Anna Voorbeeld' }] };
      if (String(url).startsWith('/api/users?')) return { data: [] };
      return undefined;
    });
    const ctx = { canWrite: true, reload };
    renderWithProviders(h(ClaimsContext.Provider, { value: ctx }, h(UploadInterviewCard, { attrs: APP })), { auth: { authFetch } });
    return { authFetch, reload, user: userEvent.setup() };
  }

  it('uploads the file with the interviewee and the date, then refreshes the claims', async () => {
    const { authFetch, reload, user } = mountCard();
    await user.click(screen.getByRole('button', { name: 'Upload transcript' }));
    const upload = screen.getByRole('button', { name: 'Upload' });
    expect(upload).toBeDisabled();
    await user.upload(screen.getByLabelText('Transcript (.txt, .docx, .vtt or .srt)'), new File([TRANSCRIPT], 'gesprek.vtt', { type: 'text/vtt' }));
    await user.type(screen.getByRole('textbox', { name: 'Who was interviewed' }), 'ann');
    await user.click(await screen.findByRole('button', { name: 'Anna Voorbeeld' }));
    expect(screen.getByText(/Interviewed:/)).toHaveTextContent('Interviewed: Anna Voorbeeld change');
    const date = screen.getByLabelText('Interviewed on');
    await user.clear(date);
    await user.type(date, '2026-10-01');
    await user.click(upload);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    const [, init] = authFetch.mock.calls.find(([u, o]) => u === '/api/contexts/c-app/interviews' && o?.method === 'POST');
    expect(init.body.get('principalId')).toBe('p-anna');
    expect(init.body.get('interviewedAt')).toBe('2026-10-01');
    expect(init.body.get('file').name).toBe('gesprek.vtt');
    expect(await screen.findByText(/its claims appear under What we know once it is read/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
  });

  it('without a model, says claims are added by hand; a refusal stays in the modal', async () => {
    const { user } = mountCard({ answer: jsonResponse({ error: 'The transcript holds no text.' }, { ok: false, status: 400 }) });
    await user.click(screen.getByRole('button', { name: 'Upload transcript' }));
    await user.upload(screen.getByLabelText('Transcript (.txt, .docx, .vtt or .srt)'), new File([' '], 'empty.txt'));
    await user.type(screen.getByRole('textbox', { name: 'Who was interviewed' }), 'ann');
    await user.click(await screen.findByRole('button', { name: 'Anna Voorbeeld' }));
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText('The transcript holds no text.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
  });

  it('is not there for a reader', () => {
    renderWithProviders(h(ClaimsContext.Provider, { value: { canWrite: false } }, h(UploadInterviewCard, { attrs: APP })));
    expect(screen.queryByTestId('action-upload-interview')).toBeNull();
  });
});

describe('ManualClaimForm', () => {
  function mountForm() {
    const onAdded = vi.fn();
    const onClose = vi.fn();
    const authFetch = makeAuthFetch((url, opts = {}) => {
      if (url === '/api/contexts/c-app/interviews/iv-1/claims' && opts.method === 'POST') return jsonResponse({ id: 'new' }, { status: 201 });
      if (url === '/api/contexts/c-app/interviews/iv-1') return { id: 'iv-1', transcript: TRANSCRIPT };
      return undefined;
    });
    renderWithProviders(h(ManualClaimForm, { contextId: 'c-app', interview: { id: 'iv-1', intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01' }, onAdded, onClose }), { auth: { authFetch } });
    return { authFetch, onAdded, onClose, user: userEvent.setup() };
  }

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
    const [, init] = authFetch.mock.calls.find(([u, o]) => o?.method === 'POST');
    expect(JSON.parse(init.body)).toEqual({ kind: 'role', value: 'does the day-to-day', subject: 'Piet', relation: 'dayToDay', quote: 'Piet does the day-to-day' });
    expect(onClose).toHaveBeenCalled();
  });

  it('a membership claim asks whether the person is in it now, and sends that status', async () => {
    const { authFetch, onAdded, user } = mountForm();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'membership');
    expect(screen.queryByRole('combobox', { name: 'What they are to it' })).toBeNull();
    const status = screen.getByRole('combobox', { name: 'In it now?' });
    expect([...status.options].map(o => o.textContent)).toEqual(['current member', 'former member', 'joined', 'left']);
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

describe('RoleTimeline', () => {
  it('draws a bar per dated role and none for a vague one', () => {
    const person = { key: 'p', name: 'Bram Test', segments: [
      { id: 'a', label: 'junior', period: '2015–2019', from: '2015-01-01', to: '2019-12-31' },
      { id: 'b', label: 'left', period: 'for a while' },
    ] };
    const { container } = renderWithProviders(h('ul', null, h(RoleTimeline, { person, today: Date.parse('2026-01-01T00:00:00Z') })));
    expect(screen.getByTestId('role-timeline')).toHaveTextContent('Bram Test: junior (2015–2019) → left (for a while)');
    const bars = container.querySelectorAll('span[style]');
    expect([...bars].map(b => [b.style.left, b.style.width])).toEqual([['0%', '100%']]);
  });

  it('draws no axis when no role is dated', () => {
    const { container } = renderWithProviders(h('ul', null, h(RoleTimeline, { person: { key: 'p', name: 'X', segments: [{ id: 'a', label: 'architect', period: 'now' }] } })));
    expect(container.querySelector('span[style]')).toBeNull();
  });
});
