// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h, createRef } from 'react';
import AppHeader from './AppHeader';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';

const navTabs = [{ key: 'matrix', label: 'Matrix' }, { key: 'contexts', label: 'Contexts' }];
const detailTabs = [
  { type: 'context', id: 'c1', displayName: 'Engineering', category: 'OrganizationalUnit' },
  { type: 'context', id: 'c2', displayName: 'SAP', category: 'LogicalApplication' },
  { type: 'context', id: 'c3', displayName: 'Opened by URL' },
  { type: 'user', id: 'u1', displayName: 'Ann' },
];

function mount(page, auth = {}) {
  return renderWithProviders(h(AppHeader, {
    isDark: false, settingsRef: createRef(), account: { name: 'A' }, me: null, settingsOpen: false,
    onToggleSettings: vi.fn(), onCloseSettings: vi.fn(), mode: 'light', setTheme: vi.fn(),
    optionalTabs: [], visibleTabs: [], toggleTab: vi.fn(), logout: vi.fn(),
    navTabs, detailTabs, page, navigate: vi.fn(), closeDetailTab: vi.fn(),
  }), { auth });
}

const READER = { hasWildcard: false, permissions: new Set(['data.read']) };

describe('AppHeader — the business view of a unit', () => {
  it('hides the tab strip on a context page for someone who cannot edit contexts', () => {
    mount('context:c1', READER);
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByText('Matrix')).toBeNull();
  });

  it('keeps the tab strip for that reader elsewhere, and for an analyst on the context page', () => {
    const { unmount } = mount('matrix', READER);
    expect(screen.getByText('Matrix')).toBeInTheDocument();
    unmount();
    mount('context:c1', { hasWildcard: false, permissions: new Set(['data.write.contexts']) });
    expect(screen.getByText('Matrix')).toBeInTheDocument();
  });
});

describe('DetailTab — a context tab shows its template icon, not a letter', () => {
  it('draws the template\'s shape per tab, Other until the template is known, and keeps letters for the rest', () => {
    mount('matrix');
    const icons = screen.getAllByTestId('detail-tab-template-icon').map(el => el.querySelector('svg').dataset.template);
    expect(icons).toEqual(['OrganizationalUnit', 'LogicalApplication', 'Other']);
    expect(screen.queryByText('C')).toBeNull();
    expect(screen.getByText('U')).toBeInTheDocument();
  });
});
