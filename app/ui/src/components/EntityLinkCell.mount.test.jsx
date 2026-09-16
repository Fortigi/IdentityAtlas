// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EntityLinkCell from './EntityLinkCell';
import { renderWithProviders } from '@ui/test-utils/renderWithProviders';

// The cell only makes sense inside a row that has its own click handler — that
// is the collision the component exists to resolve.
function renderCell({ onOpen, onRowClick = vi.fn(), title } = {}) {
  const result = renderWithProviders(
    h('table', null, h('tbody', null,
      h('tr', { onClick: onRowClick }, h(EntityLinkCell, { onOpen, title }, 'Alice Smith')))),
  );
  return { ...result, onRowClick };
}

describe('EntityLinkCell', () => {
  it('opens the entity from the keyboard, not just the mouse', async () => {
    const onOpen = vi.fn();
    renderCell({ onOpen });

    await userEvent.tab();
    const link = screen.getByRole('button', { name: 'Alice Smith' });
    expect(link).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('stops the click at the cell so the row does not also select', async () => {
    const onOpen = vi.fn();
    const { onRowClick } = renderCell({ onOpen });

    await userEvent.click(screen.getByRole('button', { name: 'Alice Smith' }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('still swallows the row click when no open handler is supplied', async () => {
    const { onRowClick } = renderCell({ onOpen: undefined });
    // No handler must mean "does nothing", not "throws" — some list variants
    // render the name column without a detail page to open.
    await userEvent.click(screen.getByRole('button', { name: 'Alice Smith' }));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('keeps the cell a real <td> and puts the title on the control', () => {
    renderCell({ onOpen: vi.fn(), title: 'Open Alice Smith' });
    expect(screen.getByRole('cell').tagName).toBe('TD');
    expect(screen.getByRole('button', { name: 'Alice Smith' })).toHaveAttribute('title', 'Open Alice Smith');
  });
});
