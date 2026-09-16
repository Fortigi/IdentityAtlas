// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { fireEvent } from '@testing-library/react';
import GridResizeHandle from './GridResizeHandle';
import { RESIZE_STEP } from '@ui/hooks/useResizableGridHeight';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';

function renderHandle(props = {}) {
  const handlers = {
    onStartDrag: vi.fn(), onResizeBy: vi.fn(), onReset: vi.fn(), isCustom: false, ...props,
  };
  renderWithProviders(h(GridResizeHandle, handlers));
  return { ...handlers, grip: screen.getByRole('button', { name: /Resize the matrix height/i }) };
}

describe('GridResizeHandle', () => {
  it('starts a drag from where the pointer went down', () => {
    const { grip, onStartDrag } = renderHandle();
    fireEvent.pointerDown(grip, { clientY: 412 });
    expect(onStartDrag).toHaveBeenCalledWith(412);
  });

  it('resizes by a step with the arrow keys, in both directions', async () => {
    const { grip, onResizeBy } = renderHandle();
    const user = userEvent.setup();
    grip.focus();
    await user.keyboard('{ArrowDown}');
    expect(onResizeBy).toHaveBeenCalledWith(RESIZE_STEP);
    await user.keyboard('{ArrowUp}');
    expect(onResizeBy).toHaveBeenCalledWith(-RESIZE_STEP);
  });

  it('hands the height back on double-click, Home and Escape', async () => {
    const { grip, onReset } = renderHandle();
    fireEvent.doubleClick(grip);
    grip.focus();
    await userEvent.setup().keyboard('{Home}{Escape}');
    expect(onReset).toHaveBeenCalledTimes(3);
  });

  it('ignores keys it has no meaning for', async () => {
    const { grip, onResizeBy, onReset } = renderHandle();
    grip.focus();
    await userEvent.setup().keyboard('{ArrowLeft}');
    expect(onResizeBy).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });

  it('offers "Fit to window" only once a height has been chosen', async () => {
    const { onReset } = renderHandle({ isCustom: true });
    const fit = screen.getByRole('button', { name: 'Fit to window' });
    await userEvent.setup().click(fit);
    expect(onReset).toHaveBeenCalled();
  });

  it('hides "Fit to window" while the matrix is at its measured fit', () => {
    renderHandle();
    expect(screen.queryByRole('button', { name: 'Fit to window' })).toBeNull();
  });
});
