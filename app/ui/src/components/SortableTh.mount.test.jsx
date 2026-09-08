// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SortableTh from './SortableTh';
import { renderWithProviders } from '@ui/test-utils/renderWithProviders';

const renderTh = (props) =>
  renderWithProviders(h('table', null, h('thead', null, h('tr', null, h(SortableTh, props)))));

describe('SortableTh', () => {
  it('exposes the column as a real button inside a columnheader', () => {
    renderTh({ label: 'Display Name', onSort: vi.fn() });

    // The <th> must stay a columnheader — the button is what makes it operable.
    const header = screen.getByRole('columnheader', { name: /display name/i });
    expect(header.tagName).toBe('TH');
    expect(screen.getByRole('button', { name: /display name/i })).toBeInTheDocument();
  });

  it('announces the sort state on the <th> via aria-sort', () => {
    const { unmount } = renderTh({ label: 'Name', active: true, dir: 'asc', onSort: vi.fn() });
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'ascending');
    unmount();

    const desc = renderTh({ label: 'Name', active: true, dir: 'desc', onSort: vi.fn() });
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'descending');
    desc.unmount();

    // An inactive column is 'none', not absent — a screen reader announces the
    // column as sortable-but-unsorted.
    renderTh({ label: 'Name', active: false, dir: 'asc', onSort: vi.fn() });
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'none');
  });

  it('sorts on Enter and on Space, not only on click', async () => {
    const onSort = vi.fn();
    renderTh({ label: 'Type', onSort });

    const button = screen.getByRole('button', { name: /type/i });
    button.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    await userEvent.click(button);

    expect(onSort).toHaveBeenCalledTimes(3);
  });

  it('is reachable by Tab', async () => {
    renderTh({ label: 'Name', onSort: vi.fn() });
    await userEvent.tab();
    expect(screen.getByRole('button', { name: /name/i })).toHaveFocus();
  });

  it('hides the direction glyphs from screen readers — aria-sort is the announcement', () => {
    renderTh({ label: 'Name', active: true, dir: 'asc', onSort: vi.fn() });
    // The ▲ would otherwise be read out as part of the column name.
    expect(screen.getByRole('button').textContent).toContain('▲');
    expect(screen.getByRole('button', { name: 'Name' })).toBeInTheDocument();
  });

  it('right-aligns numeric columns without changing the semantics', () => {
    renderTh({ label: 'Members', align: 'right', onSort: vi.fn() });
    expect(screen.getByRole('columnheader').className).toContain('text-right');
    expect(screen.getByRole('button').className).toContain('justify-end');
  });

  it('renders no inactive glyph when the table asks for none', () => {
    renderTh({ label: 'Name', inactiveIndicator: null, onSort: vi.fn() });
    expect(screen.getByRole('button').textContent).toBe('Name');
  });
});
