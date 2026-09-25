// @vitest-environment jsdom
//
// The history list: what it shows for each earlier conversation, which one it
// marks as open, and that a click reports the right id. It knows nothing about
// the API — AskPage.mount.test.jsx covers the round trip.

import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, fireEvent } from '@ui/test-utils/renderWithProviders';
import AskHistory from '@ui/components/AskHistory';

const CONVERSATIONS = [
  { conversationId: 'c-2', firstQuestion: 'Welke van deze groepen zitten in access packages?', lastAt: '2026-09-23T09:15:00Z', turns: 2 },
  { conversationId: 'c-1', firstQuestion: 'van welke groepen ben ik owner?', lastAt: '2026-09-22T15:25:00Z', turns: 1 },
];

describe('AskHistory', () => {
  it('lists each conversation by its first question, newest first as given', () => {
    renderWithProviders(<AskHistory conversations={CONVERSATIONS} onNew={vi.fn()} onOpen={vi.fn()} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Welke van deze groepen zitten in access packages?');
    expect(items[1]).toHaveTextContent('van welke groepen ben ik owner?');
  });

  it('says how many questions each one holds, in the singular when there is one', () => {
    renderWithProviders(<AskHistory conversations={CONVERSATIONS} onNew={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByText(/2 questions/)).toBeInTheDocument();
    expect(screen.getByText(/1 question$/)).toBeInTheDocument();
  });

  it('marks the open conversation and no other', () => {
    renderWithProviders(<AskHistory conversations={CONVERSATIONS} activeId="c-1" onNew={vi.fn()} onOpen={vi.fn()} />);
    const current = screen.getAllByRole('button').filter(b => b.getAttribute('aria-current') === 'true');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('van welke groepen ben ik owner?');
  });

  it('reports which conversation was clicked, by id', () => {
    const onOpen = vi.fn();
    renderWithProviders(<AskHistory conversations={CONVERSATIONS} onNew={vi.fn()} onOpen={onOpen} />);
    fireEvent.click(screen.getByText('van welke groepen ben ik owner?'));
    expect(onOpen).toHaveBeenCalledWith('c-1');
  });

  it('offers a new conversation, and reports the click', () => {
    const onNew = vi.fn();
    renderWithProviders(<AskHistory conversations={[]} onNew={onNew} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /New conversation/ }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('says so when there is nothing yet, rather than showing an empty box', () => {
    renderWithProviders(<AskHistory conversations={[]} onNew={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByText(/No earlier conversations yet/)).toBeInTheDocument();
  });

  it('will not switch or start over while a question is being answered', () => {
    // Switching mid-answer would drop the reply that is minutes away.
    renderWithProviders(<AskHistory conversations={CONVERSATIONS} busy onNew={vi.fn()} onOpen={vi.fn()} />);
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
  });

  it('shortens a long first question to one line', () => {
    const long = { conversationId: 'c-3', firstQuestion: 'x'.repeat(120), lastAt: null, turns: 1 };
    renderWithProviders(<AskHistory conversations={[long]} onNew={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByRole('listitem').textContent).toMatch(/…/);
    expect(screen.getByRole('listitem').textContent.length).toBeLessThan(120);
  });

  it('shows an error line when the list could not be loaded', () => {
    renderWithProviders(<AskHistory conversations={[]} error="HTTP 500" onNew={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be loaded/);
  });
});
