// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import HeaderCellButton from './HeaderCellButton';
import { renderWithProviders } from '@ui/test-utils/renderWithProviders';

const renderHeader = (props = {}) =>
  renderWithProviders(
    h('table', null, h('thead', null, h('tr', null,
      h('th', { scope: 'col', colSpan: 3 }, h(HeaderCellButton, props, 'Payroll'))))),
  );

describe('HeaderCellButton', () => {
  it('makes a clickable matrix header operable by keyboard', async () => {
    const onClick = vi.fn();
    renderHeader({ onClick });

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Payroll' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('leaves the <th> a columnheader and keeps its colSpan', () => {
    renderHeader({ onClick: vi.fn() });
    const header = screen.getByRole('columnheader');
    expect(header.tagName).toBe('TH');
    expect(header).toHaveAttribute('colspan', '3');
  });

  it('renders the children bare when the header is not clickable', () => {
    renderHeader({ onClick: undefined });

    // A non-clickable header must not gain a tab stop; this is what keeps the
    // matrix from growing one focus stop per column label.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader')).toHaveTextContent('Payroll');
  });

  it('uses the supplied label as the accessible name when the text is not enough', () => {
    renderHeader({ onClick: vi.fn(), label: 'Sort by Payroll', title: 'Payroll' });
    expect(screen.getByRole('button', { name: 'Sort by Payroll' })).toHaveAttribute('title', 'Payroll');
  });
});
