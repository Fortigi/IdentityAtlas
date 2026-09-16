// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FilterPill from './FilterPill';
import { renderWithProviders } from '@ui/test-utils/renderWithProviders';

const renderPill = (props = {}) =>
  renderWithProviders(h(FilterPill, { onToggle: vi.fn(), ...props }, 'Finance'));

describe('FilterPill', () => {
  it('is a real button, so the chip is reachable by Tab and fires on Enter', async () => {
    const onToggle = vi.fn();
    renderPill({ onToggle });

    await userEvent.tab();
    const toggle = screen.getByRole('button', { name: 'Finance' });
    expect(toggle).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('reports whether the filter is currently applied via aria-pressed', () => {
    const { unmount } = renderPill({ active: true });
    expect(screen.getByRole('button', { name: 'Finance' })).toHaveAttribute('aria-pressed', 'true');
    unmount();

    // Inactive must be 'false', not a missing attribute — otherwise the chip
    // reads as a plain button and the on/off state is never announced.
    renderPill({ active: false });
    expect(screen.getByRole('button', { name: 'Finance' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders no delete control unless the caller supplies one', () => {
    renderPill();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('gives the ✕ its own accessible name and its own handler', async () => {
    const onToggle = vi.fn();
    const onDelete = vi.fn();
    renderPill({ onToggle, onDelete, deleteLabel: 'Remove tag Finance' });

    await userEvent.click(screen.getByRole('button', { name: 'Remove tag Finance' }));

    // Siblings, not nested: deleting must not also toggle the filter.
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('keeps the two actions as siblings — a button never nests inside a button', () => {
    renderPill({ onDelete: vi.fn(), deleteLabel: 'Remove tag Finance' });
    const [toggle, remove] = screen.getAllByRole('button');
    expect(toggle.contains(remove)).toBe(false);
  });
});
