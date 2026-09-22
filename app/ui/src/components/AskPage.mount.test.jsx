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
