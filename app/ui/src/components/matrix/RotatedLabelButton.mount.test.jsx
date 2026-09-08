// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RotatedLabelButton from './RotatedLabelButton';
import { renderWithProviders } from '@ui/test-utils/renderWithProviders';

const renderLabel = (props = {}) =>
  renderWithProviders(h(RotatedLabelButton, { onClick: vi.fn(), ...props }, 'Sales EMEA'));

describe('RotatedLabelButton', () => {
  it('is a real button carrying its visible text as the accessible name', async () => {
    const onClick = vi.fn();
    renderLabel({ onClick });

    await userEvent.tab();
    const label = screen.getByRole('button', { name: 'Sales EMEA' });
    expect(label).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps the vertical rotation the matrix header layout depends on', () => {
    renderLabel();
    // Swapping the <div> for a <button> must not straighten the column labels —
    // the whole matrix header height is sized around the rotated text.
    expect(screen.getByRole('button')).toHaveStyle({
      writingMode: 'vertical-lr',
      transform: 'rotate(180deg)',
      whiteSpace: 'nowrap',
    });
  });

  it('resets the button box back to the <div> it replaced', () => {
    renderLabel();
    // A <button> is inline-block and centres its text; both would shift every
    // label. These three resets are the visual-parity contract.
    expect(screen.getByRole('button')).toHaveStyle({
      display: 'block',
      textAlign: 'start',
      margin: '0 auto',
    });
  });

  it('lets a caller size the label without losing the rotation', () => {
    renderLabel({ style: { height: '120px' } });
    const button = screen.getByRole('button');
    expect(button).toHaveStyle({ height: '120px' });
    expect(button).toHaveStyle({ writingMode: 'vertical-lr' });
  });

  it('keeps the caller className alongside the focus ring', () => {
    renderLabel({ className: 'text-xs', title: 'Sales EMEA' });
    const button = screen.getByRole('button');
    expect(button.className).toContain('text-xs');
    expect(button.className).toContain('focus-visible:ring-2');
    expect(button).toHaveAttribute('title', 'Sales EMEA');
  });
});
