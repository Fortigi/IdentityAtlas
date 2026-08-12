// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import RecentChangesSection from './RecentChangesSection';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';

const EVENTS = [
  {
    operation: 'added',
    at: '2026-01-05T10:00:00Z',
    summary: 'Assigned to Payroll Access',
    counterpartyKind: 'access-package',
    counterpartyId: 'ap-1',
    counterpartyLabel: 'Payroll Access',
  },
];

function renderSection(overrides = {}) {
  return renderWithProviders(
    h(RecentChangesSection, {
      events: EVENTS,
      addedCount: 1,
      removedCount: 0,
      sinceDays: 30,
      loading: false,
      onOpenDetail: () => {},
      ...overrides,
    }),
  );
}

describe('RecentChangesSection', () => {
  it('shows no table until the section is expanded', () => {
    const { container } = renderSection();
    expect(screen.getByText('Recent Changes')).toBeInTheDocument();
    expect(container.querySelector('table')).toBeNull();
  });

  it('wraps the events table in a horizontally-scrolling container once expanded', async () => {
    const { container } = renderSection();
    const user = userEvent.setup();

    await user.click(screen.getByText('Recent Changes'));

    expect(await screen.findByRole('button', { name: 'Payroll Access' })).toBeInTheDocument();
    const wrapper = container.querySelector('table').closest('.overflow-x-auto');
    expect(wrapper).toBeTruthy();
  });

  it('renders the empty state when there are no events', async () => {
    renderSection({ events: [], addedCount: 0 });
    const user = userEvent.setup();

    await user.click(screen.getByText('Recent Changes'));
    expect(await screen.findByText(/No relationship changes recorded/)).toBeInTheDocument();
  });
});
