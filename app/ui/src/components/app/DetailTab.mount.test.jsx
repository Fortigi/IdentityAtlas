// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DetailTab from './DetailTab';
import { renderWithProviders } from '@ui/test-utils/renderWithProviders';

const TAB = { type: 'user', id: 'u1', displayName: 'Alice Smith' };

const renderTab = (props = {}) =>
  renderWithProviders(h(DetailTab, { tab: TAB, onSelect: vi.fn(), onClose: vi.fn(), ...props }));

// The tab announces exactly the entity name: the type badge is decorative and
// the ✕ is a separately-named sibling. An exact match is what catches either of
// those leaking back into the tab's accessible name.
const tab = () => screen.getByRole('button', { name: 'Alice Smith' });
const closeButton = () => screen.getByRole('button', { name: 'Close Alice Smith' });

describe('DetailTab', () => {
  it('selects the tab from the keyboard', async () => {
    const onSelect = vi.fn();
    renderTab({ onSelect });

    await userEvent.tab();
    expect(tab()).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('gives the close control its own name, and closing does not also select', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderTab({ onSelect, onClose });

    await userEvent.click(closeButton());

    expect(onClose).toHaveBeenCalledWith('user', 'u1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('reaches the close button by Tab, right after the tab itself', async () => {
    renderTab();
    await userEvent.tab();
    await userEvent.tab();
    expect(closeButton()).toHaveFocus();
  });

  it('nests no control inside another — the ✕ is a sibling, not a child', () => {
    renderTab();
    const tabEl = tab();

    // The tab body must not itself be a <button>: the ✕ is a real button, and a
    // <button> inside a <button> is invalid HTML — that nesting is what left the
    // old ✕ unreachable.
    expect(tabEl.tagName).not.toBe('BUTTON');
    expect(tabEl).toHaveAttribute('role', 'button');
    expect(tabEl).toHaveAttribute('tabindex', '0');
    expect(closeButton().tagName).toBe('BUTTON');
  });

  it('marks only the active tab as the current page', () => {
    const { unmount } = renderTab({ active: true });
    expect(tab()).toHaveAttribute('aria-current', 'page');
    unmount();

    renderTab({ active: false });
    expect(tab()).not.toHaveAttribute('aria-current');
  });

  it('keeps the close control visible while it has keyboard focus', () => {
    renderTab();
    // It is hover-revealed for the mouse; without this a keyboard user would
    // tab to an invisible control.
    expect(closeButton().className).toContain('focus-visible:opacity-100');
  });
});
