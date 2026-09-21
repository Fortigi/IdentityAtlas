// @vitest-environment jsdom
//
// The page a Teams card's "Open the full report" link opens.
//
// Two things matter here and neither is the table. First, the page must show the
// QUESTION and the interpretation together — that pairing is how a wrong name
// match gets caught, and the card shows it for the same reason. Second, a link
// that is not yours must land on an explanation rather than a blank table or a
// stack trace: forwarding a chat message is the normal way that happens.

import { describe, it, expect, vi } from 'vitest';
import {
  renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor,
} from '@ui/test-utils/renderWithProviders';
import BotAnswerPage from '@ui/components/reports/BotAnswerPage';

const ANSWER = {
  question: 'which of my direct reports have access to Finance?',
  explanation: 'Users whose manager is Wim van den Heijkant and who have access to Finance',
  form: 'list',
  columns: [{ key: 'displayName', label: 'Name' }, { key: 'email', label: 'Email' }],
  rows: [
    { displayName: 'Jan de Vries', email: 'jan@example.com', _entity: { kind: 'user', id: 'p1' } },
    { displayName: 'Ada Lovelace', email: 'ada@example.com', _entity: { kind: 'user', id: 'p2' } },
  ],
  total: 2,
};

function renderAnswer({ response = jsonResponse(ANSWER), answerId = 'c0ffee', ...props } = {}) {
  const authFetch = makeAuthFetch(() => (typeof response === 'function' ? response() : response));
  const utils = renderWithProviders(<BotAnswerPage answerId={answerId} {...props} />, { auth: { authFetch } });
  return { ...utils, authFetch };
}

describe('BotAnswerPage', () => {
  it('asks the API for this answer, by id', async () => {
    const { authFetch } = renderAnswer({ answerId: 'abc-123' });
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    expect(String(authFetch.mock.calls[0][0])).toBe('/api/bot-answers/abc-123');
  });

  it('escapes the id rather than interpolating it into the URL raw', async () => {
    const { authFetch } = renderAnswer({ answerId: 'a/b?c' });
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    expect(String(authFetch.mock.calls[0][0])).toBe('/api/bot-answers/a%2Fb%3Fc');
  });

  it('shows the question that was asked and what the bot understood', async () => {
    renderAnswer();
    expect(await screen.findByText(/which of my direct reports have access to Finance\?/)).toBeInTheDocument();
    expect(screen.getByText(/Users whose manager is Wim van den Heijkant/)).toBeInTheDocument();
  });

  it('shows every row and column, not the card\'s ten and four', async () => {
    renderAnswer();
    expect(await screen.findByText('Jan de Vries')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    // The second column is the one a card would have dropped first.
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Email' })).toBeInTheDocument();
  });

  it('says it is running while the report runs, because it re-runs the definition', async () => {
    // A bot answer is not a stored result — opening the link runs the query
    // again, which is why there is a wait to explain at all.
    renderAnswer({ response: () => new Promise(() => {}) });
    expect(await screen.findByText(/Running the report/)).toBeInTheDocument();
  });

  it('explains a link that is not yours instead of showing an empty table', async () => {
    renderAnswer({ response: jsonResponse({ error: 'No such answer' }, { ok: false, status: 404 }) });

    await waitFor(() => expect(screen.getByText(/only the person who asked can open it/i)).toBeInTheDocument());
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders an answer that matched nothing without claiming it failed', async () => {
    renderAnswer({ response: jsonResponse({ ...ANSWER, rows: [], total: 0 }) });

    expect(await screen.findByText(/which of my direct reports/)).toBeInTheDocument();
    expect(screen.getByText(/No rows/i)).toBeInTheDocument();
  });

  it('still shows the question when the definition produced no explanation', async () => {
    const { explanation, ...withoutExplanation } = ANSWER;
    renderAnswer({ response: jsonResponse(withoutExplanation) });

    expect(await screen.findByText(/which of my direct reports/)).toBeInTheDocument();
    expect(screen.queryByText(/Understood as/)).not.toBeInTheDocument();
  });

  it('opens a detail tab when a row is clicked, like every other report', async () => {
    const onOpenDetail = vi.fn();
    renderAnswer({ onOpenDetail });

    const link = await screen.findByText('Jan de Vries');
    link.click();
    await waitFor(() => expect(onOpenDetail).toHaveBeenCalled());
  });
});
