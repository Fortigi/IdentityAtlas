// @vitest-environment jsdom
//
// The header account menu. Its most load-bearing part is the Visible Tabs
// section: each optional tab gets a switch whose accessible name must say what
// it does ("Show Reports tab") rather than repeat the tab label — a toggle
// named plainly "Reports" is indistinguishable from the "Reports" tab in the
// nav for anyone (or any test) selecting by role and name.

import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, fireEvent } from '@ui/test-utils/renderWithProviders';
import SettingsMenu from '@ui/components/app/SettingsMenu';

const OPTIONAL_TABS = [
  { key: 'systems', label: 'Systems' },
  { key: 'reports', label: 'Reports' },
];

function renderMenu(overrides = {}) {
  const props = {
    settingsRef: { current: null },
    account: { name: 'Test Analyst', username: 'analyst@example.com' },
    settingsOpen: true,
    onToggle: vi.fn(),
    onClose: vi.fn(),
    mode: 'light',
    setTheme: vi.fn(),
    optionalTabs: OPTIONAL_TABS,
    visibleTabs: ['systems'],
    toggleTab: vi.fn(),
    logout: vi.fn(),
    ...overrides,
  };
  return { props, ...renderWithProviders(<SettingsMenu {...props} />) };
}

describe('SettingsMenu', () => {
  it('is collapsed to just the account button until it is opened', () => {
    renderMenu({ settingsOpen: false });

    expect(screen.getByTitle('Settings')).toBeInTheDocument();
    expect(screen.queryByText('Visible Tabs')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('opens the dropdown from the account button', () => {
    const { props } = renderMenu({ settingsOpen: false });

    fireEvent.click(screen.getByTitle('Settings'));
    expect(props.onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows the signed-in account', () => {
    renderMenu();

    // Once on the trigger button, once as the dropdown's header.
    expect(screen.getAllByText('Test Analyst')).toHaveLength(2);
    expect(screen.getByText('analyst@example.com')).toBeInTheDocument();
  });

  it('names each tab toggle for what it does, not after the tab itself', () => {
    renderMenu();

    // The name is distinct from the nav tab's own name, so "the Reports tab"
    // and "the switch that shows the Reports tab" are separately addressable.
    expect(screen.getByRole('switch', { name: 'Show Reports tab' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Show Systems tab' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Reports' })).not.toBeInTheDocument();
  });

  it('reports each toggle on/off state through aria-checked', () => {
    renderMenu({ visibleTabs: ['systems'] });

    expect(screen.getByRole('switch', { name: 'Show Systems tab' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Show Reports tab' })).not.toBeChecked();
  });

  it('treats missing preferences as every optional tab off', () => {
    renderMenu({ visibleTabs: undefined });

    for (const tab of OPTIONAL_TABS) {
      expect(screen.getByRole('switch', { name: `Show ${tab.label} tab` })).not.toBeChecked();
    }
  });

  it('toggles the tab it was clicked for', () => {
    const { props } = renderMenu();

    fireEvent.click(screen.getByRole('switch', { name: 'Show Reports tab' }));
    expect(props.toggleTab).toHaveBeenCalledWith('reports');
  });

  it('closes the menu when signing out', () => {
    const { props } = renderMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.logout).toHaveBeenCalledTimes(1);
  });

  it('offers no sign out when there is no signed-in account', () => {
    renderMenu({ account: null });

    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    // The button still renders, with a placeholder initial and name rather
    // than a crash — on the trigger and in the dropdown header.
    expect(screen.getByTitle('Settings')).toHaveTextContent('?');
    expect(screen.getAllByText('User')).toHaveLength(2);
  });
});
