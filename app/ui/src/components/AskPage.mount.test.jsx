// @vitest-environment jsdom
//
// The Ask page: a question in, an answer out, and nothing else on screen.
//
// What is worth pinning here is not the layout but the two things that make an
// answer trustworthy, both of which the Teams card learned the hard way: the
// INTERPRETATION is shown above the rows, because a wrong name match produces a
// page of perfectly formatted wrong answers and that line is the only place a
// reader can catch it; and a report that matched nothing says so instead of
// rendering an empty table that looks like a loading state.

import { describe, it, expect, vi } from 'vitest';
import {
  renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor,
} from '@ui/test-utils/renderWithProviders';
import AskPage from '@ui/components/AskPage';

const STATUS = { available: true, model: 'qwen3:4b', warm: 'ready' };

const REPORT_REPLY = {
  kind: 'report',
  raw: '{}',
  spec: { entity: 'group', match: 'all', conditions: [], columns: ['displayName'] },
};

const RUN_RESULT = {
  ok: true,
  explanation: {
    title: 'Groups where',
    lines: [{ depth: 0, text: 'is in a business role' }],
  },
  columns: [{ key: 'displayName', label: 'Name' }],
  rows: [
    { displayName: 'ASML', _entity: { kind: 'resource', id: 'g1' } },
    { displayName: 'Bestuur', _entity: { kind: 'resource', id: 'g2' } },
  ],
  total: 2,
  truncated: false,
  spec: REPORT_REPLY.spec,
};

/** Routes the page touches: model status, interpret, run. */
function routes({ run = RUN_RESULT, status = STATUS } = {}) {
  return makeAuthFetch((url) => {
    if (String(url).includes('/nl-reports/status')) return jsonResponse(status);
    if (String(url).includes('/nl-reports/interpret')) return jsonResponse(REPORT_REPLY);
    if (String(url).includes('/nl-reports/run')) return jsonResponse(run);
    if (String(url).includes('/nl-reports/conversations')) return jsonResponse({ conversations: [] });
    return jsonResponse({});
  });
}

const renderPage = (over = {}) =>
  renderWithProviders(<AskPage onOpenDetail={vi.fn()} {...over.props} />, { auth: { authFetch: over.authFetch ?? routes() } });

/** Type a question and submit it. */
async function ask(text = 'welke groepen zitten in access packages?') {
  const box = await screen.findByRole('textbox');
  const { fireEvent } = await import('@testing-library/react');
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: 'Enter' });
}

describe('AskPage', () => {
  it('offers a question box and says the question stays on your own hardware', async () => {
    renderPage();
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
    expect(screen.getByText(/never leaves it/i)).toBeInTheDocument();
  });

  it('runs the definition the model returned, without a second click', async () => {
    // The builder waits for Run because the analyst may edit the definition
    // first. Here there is nothing to edit, so waiting is only a click.
    const authFetch = routes();
    renderPage({ authFetch });
    await ask();

    await waitFor(() => {
      const called = authFetch.mock.calls.map(c => String(c[0]));
      expect(called.some(u => u.includes('/nl-reports/run'))).toBe(true);
    });
  });

  it('shows what it understood ABOVE the rows', async () => {
    renderPage();
    await ask();

    expect(await screen.findByText(/Understood as/i)).toBeInTheDocument();
    expect(screen.getByText('Groups where')).toBeInTheDocument();
    expect(screen.getByText(/is in a business role/)).toBeInTheDocument();
  });

  it('shows the question that was asked beside the answer', async () => {
    // So a scrolled-back answer still says what it is an answer to.
    renderPage();
    await ask('welke groepen zitten in access packages?');
    expect(await screen.findByText(/welke groepen zitten in access packages\?/)).toBeInTheDocument();
  });

  it('renders the rows as a table', async () => {
    renderPage();
    await ask();

    expect(await screen.findByText('ASML')).toBeInTheDocument();
    expect(screen.getByText('Bestuur')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
  });

  it('counts the records, in words that match the count', async () => {
    renderPage();
    await ask();
    expect(await screen.findByText(/2 records/)).toBeInTheDocument();
  });

  it('says an answer matched nothing instead of drawing an empty table', async () => {
    // A zero-row answer is a real answer and the most common way a report is
    // subtly wrong — the interpretation has to stay visible above it.
    renderPage({ authFetch: routes({ run: { ...RUN_RESULT, rows: [], total: 0 } }) });
    await ask();

    expect(await screen.findByText(/No rows/i)).toBeInTheDocument();
    expect(screen.getByText('Groups where')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says so when the model server is not reachable, rather than failing silently', async () => {
    renderPage({ authFetch: routes({ status: { available: false, reason: 'no-model' } }) });
    expect(await screen.findByText(/not available/i)).toBeInTheDocument();
  });

  it('shows no answer section before anything has been asked', async () => {
    renderPage();
    await screen.findByRole('textbox');
    expect(screen.queryByText(/Understood as/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('history on the Ask page', () => {
  const LIST = [{ conversationId: 'c-old', firstQuestion: 'van welke groepen ben ik owner?', lastAt: '2026-09-22T15:25:00Z', turns: 1 }];
  const OLD_TURNS = [{
    question: 'van welke groepen ben ik owner?', outcome: 'answered', definition: REPORT_REPLY.spec,
    rawReply: JSON.stringify({ kind: 'report', assumptions: [], spec: REPORT_REPLY.spec }), createdAt: '2026-09-22T15:25:00Z',
  }];

  function withHistory({ list = LIST, turns = OLD_TURNS } = {}) {
    return makeAuthFetch((url) => {
      const u = String(url);
      if (u.includes('/nl-reports/status')) return jsonResponse(STATUS);
      if (u.includes('/nl-reports/conversations/')) return jsonResponse({ conversationId: 'c-old', turns });
      if (u.includes('/nl-reports/conversations')) return jsonResponse({ conversations: list });
      if (u.includes('/nl-reports/interpret')) return jsonResponse(REPORT_REPLY);
      if (u.includes('/nl-reports/run')) return jsonResponse(RUN_RESULT);
      return jsonResponse({});
    });
  }

  it('lists earlier conversations beside the chat', async () => {
    renderPage({ authFetch: withHistory() });
    expect(await screen.findByText('van welke groepen ben ik owner?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New conversation/ })).toBeInTheDocument();
  });

  it('opens an earlier conversation: its turns come back on screen and its last answer is run again', async () => {
    const authFetch = withHistory();
    renderPage({ authFetch });
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(await screen.findByText('van welke groepen ben ik owner?'));

    // The question is now in the chat as well as in the sidebar.
    await waitFor(() => expect(screen.getAllByText('van welke groepen ben ik owner?').length).toBeGreaterThan(1));
    expect(await screen.findByText(/updated the report definition/)).toBeInTheDocument();
    await waitFor(() => expect(authFetch.mock.calls.map(c => String(c[0])).some(u => u.includes('/nl-reports/run'))).toBe(true));
    expect(await screen.findByText('ASML')).toBeInTheDocument();
  });

  it('says so when an earlier conversation cannot be opened', async () => {
    const authFetch = makeAuthFetch((url) => {
      const u = String(url);
      if (u.includes('/nl-reports/status')) return jsonResponse(STATUS);
      if (u.includes('/nl-reports/conversations/')) return jsonResponse({ error: 'gone' }, { ok: false, status: 404 });
      if (u.includes('/nl-reports/conversations')) return jsonResponse({ conversations: LIST });
      return jsonResponse({});
    });
    renderPage({ authFetch });
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(await screen.findByText('van welke groepen ben ik owner?'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/);
  });

  it('starts a new conversation with an empty chat', async () => {
    renderPage({ authFetch: withHistory() });
    await ask();
    expect(await screen.findByText(/Understood as/i)).toBeInTheDocument();
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByRole('button', { name: /New conversation/ }));
    await waitFor(() => expect(screen.queryByText(/Understood as/i)).not.toBeInTheDocument());
  });

  it('re-reads the list once a question has been answered, so the new chat appears', async () => {
    const authFetch = withHistory();
    renderPage({ authFetch });
    await screen.findByText('van welke groepen ben ik owner?');
    const before = authFetch.mock.calls.filter(c => /\/nl-reports\/conversations$/.test(String(c[0]))).length;
    await ask();
    await screen.findByText(/Understood as/i);
    await waitFor(() => expect(authFetch.mock.calls.filter(c => /\/nl-reports\/conversations$/.test(String(c[0]))).length).toBeGreaterThan(before));
  });
});
