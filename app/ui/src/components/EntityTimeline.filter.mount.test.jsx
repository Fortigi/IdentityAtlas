// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderWithProviders, screen, within, userEvent } from '@ui/test-utils/renderWithProviders';
import EntityTimeline from './EntityTimeline';

const at = '2026-10-27T10:00:00Z';
const events = [
  { at, operation: 'added', eventKind: 'unit', category: 'people', summary: 'Lisa Vos joined (list upload)' },
  { at, operation: 'changed', eventKind: 'unit', category: 'roles', summary: 'Accountable changed: Tom → Lisa (analyst)' },
];

describe('EntityTimeline — the category filter', () => {
  it('hides a category\'s events when switched off, and shows them again', async () => {
    const user = userEvent.setup();
    renderWithProviders(h(EntityTimeline, { events, loading: false, sinceDays: 90 }));
    const filter = screen.getByRole('group', { name: 'Show' });
    const people = within(filter).getByRole('button', { name: 'People' });
    expect(people).toHaveAttribute('aria-pressed', 'true');

    await user.click(people);
    expect(people).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('Lisa Vos joined (list upload)')).toBeNull();
    expect(screen.getByText('Accountable changed: Tom → Lisa (analyst)')).toBeInTheDocument();

    await user.click(people);
    expect(screen.getByText('Lisa Vos joined (list upload)')).toBeInTheDocument();
  });
});
