// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ModalBackdrop from './ModalBackdrop';
import { renderWithProviders } from '@ui/test-utils/renderWithProviders';

const renderBackdrop = (props = {}) =>
  renderWithProviders(
    h(ModalBackdrop, {
      onDismiss: vi.fn(),
      className: 'fixed inset-0 bg-black/50',
      panelClassName: 'bg-white',
      ...props,
    }, h('button', { type: 'button' }, 'Save')),
  );

describe('ModalBackdrop', () => {
  it('dismisses when the overlay itself is clicked', async () => {
    const onDismiss = vi.fn();
    const { container } = renderBackdrop({ onDismiss });

    await userEvent.click(container.querySelector('.fixed'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not dismiss when the click lands inside the panel', async () => {
    const onDismiss = vi.fn();
    renderBackdrop({ onDismiss });

    // The panel's stopPropagation guard is the whole reason it carries onClick;
    // without it every click inside an open modal would close it.
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('adds no tab stop of its own — the backdrop must never become a control', async () => {
    renderBackdrop();

    // Focus order inside an open modal belongs to the modal's own controls. A
    // focusable backdrop would insert a phantom, unnamed stop before them.
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: '' })).not.toBeInTheDocument();
  });

  it('applies the caller layout to the overlay and the panel separately', () => {
    const { container } = renderBackdrop({ panelStyle: { width: '400px' } });
    const overlay = container.querySelector('.fixed');
    const panel = overlay.firstElementChild;

    expect(panel.className).toBe('bg-white');
    expect(panel).toHaveStyle({ width: '400px' });
  });

  it('renders its children with no dismiss handler at all', () => {
    // Some callers own dismissal elsewhere; the backdrop must still render.
    renderBackdrop({ onDismiss: undefined });
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});
