// @vitest-environment jsdom
//
// A context owner's navigation: sub-tabs and a tree of only what they answer for,
// so a sub-unit is always one click from the way back.

import { describe, it, expect, vi } from 'vitest';
import ContextOwnerPage from './ContextOwnerPage';
import { ownerTreeView, ownerPageTabs, ownerActiveTab, ROLES_TAB, UNITS_TAB } from './contextOwner/useOwnerTree';
import { renderWithProviders, makeAuthFetch, screen, userEvent, within } from '@ui/test-utils/renderWithProviders';

const CTO = 'aaaaaaaa-0000-4000-8000-000000000001';
const DEV = 'aaaaaaaa-0000-4000-8000-000000000002';
const AZURE = 'aaaaaaaa-0000-4000-8000-000000000003';
const PORTFOLIO = 'aaaaaaaa-0000-4000-8000-000000000004';
const ROLE = 'bbbbbbbb-0000-4000-8000-000000000001';
const node = (id, displayName, contextCategory, targetType, children = []) => ({
  id, displayName, contextCategory, targetType, variant: 'generated', contextType: 'Department', totalMemberCount: 3, directMemberCount: 3, children,
});
const FOREST = [
  node(CTO, 'CTO unit', 'OrganizationalUnit', 'Principal', [node(DEV, 'Development', 'OrganizationalUnit', 'Principal')]),
  node(AZURE, 'Azure', 'LogicalApplication', 'Resource'),
];
const detail = (id, displayName, contextCategory, targetType, subContexts = []) => ({
  attributes: { id, displayName, variant: 'generated', targetType, contextType: 'Department', contextCategory, directMemberCount: 1, totalMemberCount: 1 },
  subContexts,
});

const HELD = [
  { id: AZURE, displayName: 'Azure', role: 'Accountable', contextCategory: 'LogicalApplication', targetType: 'Resource' },
  { id: CTO, displayName: 'CTO unit', role: 'Accountable', contextCategory: 'OrganizationalUnit', targetType: 'Principal' },
];

function mount(tree = FOREST, held = HELD) {
  const authFetch = makeAuthFetch((url) => {
    const u = String(url);
    if (u.endsWith('/api/context-owner/tree')) return tree;
    if (u.includes('/team-overview')) return { sinceDays: 30, totalPeople: 0, truncated: false, people: [], roles: [], changes: [] };
    if (u.includes('/people')) return { data: [], total: 0, counts: { current: 0, former: 0, all: 0, decide: 0 } };
    if (u.includes('/roles') || u.includes('/relationships') || u.includes('/claims')) return [];
    if (u.includes(`/api/contexts/${PORTFOLIO}/members`)) return { data: [{ id: ROLE, displayName: 'Finance clerk', resourceType: 'BusinessRole' }], total: 1 };
    if (u.includes('/members')) return { data: [], total: 0 };
    if (u.endsWith(`/api/contexts/${CTO}`)) return detail(CTO, 'CTO unit', 'OrganizationalUnit', 'Principal', [{ id: DEV, displayName: 'Development', memberCount: 1 }]);
    if (u.endsWith(`/api/contexts/${DEV}`)) return detail(DEV, 'Development', 'OrganizationalUnit', 'Principal');
    if (u.endsWith(`/api/contexts/${AZURE}`)) return detail(AZURE, 'Azure', 'LogicalApplication', 'Resource');
    if (u.endsWith(`/api/contexts/${PORTFOLIO}`)) return detail(PORTFOLIO, 'Finance roles', 'Catalog', 'Resource');
    return undefined;
  });
  renderWithProviders(<ContextOwnerPage />, {
    auth: {
      authFetch, logout: vi.fn(), authEnabled: true, hasWildcard: false, permissions: new Set(), account: { name: 'Carla' },
      contextOwner: {
        contexts: held,
        contextIds: [CTO, DEV, ...held.map(c => c.id)],
      },
    },
  });
}

const tree = () => within(screen.getByRole('navigation', { name: 'What you answer for' }));

describe('ContextOwnerPage: the tree', () => {
  it('opens on the organisation, with only the tabs that hold something', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'CTO unit', level: 2 })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: /Applications/ })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^Tags/ })).toBeNull();
    expect(tree().getByText('Development')).toBeInTheDocument();
    expect(tree().queryByText('Azure')).toBeNull();
  });

  it('starts on the direct sub-units, with what is below them folded until opened', async () => {
    const user = userEvent.setup();
    const deep = [node(CTO, 'CTO unit', 'OrganizationalUnit', 'Principal', [
      node(DEV, 'Development', 'OrganizationalUnit', 'Principal', [node('aaaaaaaa-0000-4000-8000-000000000009', 'Backend team', 'OrganizationalUnit', 'Principal')]),
    ])];
    mount(deep);
    await screen.findByRole('tab', { name: /Organisation/ });
    expect(await tree().findByText('Development')).toBeInTheDocument();
    expect(tree().queryByText('Backend team')).toBeNull();
    await user.click(tree().getAllByRole('button').find(b => b.getAttribute('aria-expanded') === 'false'));
    expect(await tree().findByText('Backend team')).toBeInTheDocument();
  });

  it('names the units above the tree, top first, as plain text', async () => {
    mount([{ ...FOREST[0], ancestors: ['Board', 'Management'] }, FOREST[1]]);
    await screen.findByRole('tab', { name: /Organisation/ });
    const trail = within(tree().getByRole('list', { name: 'Part of' }));
    expect(trail.getAllByRole('listitem').map(li => li.textContent)).toEqual(['Board', 'Management']);
    expect(trail.queryByRole('button')).toBeNull();
  });

  it('shows no trail for a tree at the top', async () => {
    mount();
    await screen.findByRole('tab', { name: /Organisation/ });
    expect(tree().queryByRole('list', { name: 'Part of' })).toBeNull();
  });

  it('drops the Sub-units section, because the tree shows them', async () => {
    mount();
    await screen.findByRole('region', { name: 'Your team' });
    await screen.findByRole('tab', { name: /Applications/ });
    expect(await tree().findByText('Development')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Sub-units' })).toBeNull();
  });

  it('goes into a sub-unit and back through the tree', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole('tab', { name: /Applications/ });
    await user.click(await tree().findByText('Development'));
    expect(await screen.findByRole('heading', { name: 'Development', level: 2 })).toBeInTheDocument();
    expect(tree().getByText('CTO unit')).toBeInTheDocument();
    await user.click(tree().getByText('CTO unit'));
    expect(await screen.findByRole('heading', { name: 'CTO unit', level: 2 })).toBeInTheDocument();
  });

  it('gives the Accountable or Responsible of a role portfolio a tab of its own, listing its business roles', async () => {
    const user = userEvent.setup();
    const portfolio = { id: PORTFOLIO, displayName: 'Finance roles', role: 'Responsible', contextCategory: 'Catalog', targetType: 'Resource' };
    mount([...FOREST, node(PORTFOLIO, 'Finance roles', 'Catalog', 'Resource')], [...HELD, portfolio]);
    await user.click(await screen.findByRole('tab', { name: /Role portfolios/ }));
    expect(await screen.findByRole('heading', { name: 'Finance roles', level: 2 })).toBeInTheDocument();
    expect(tree().queryByText('CTO unit')).toBeNull();
    expect(await screen.findByText('Finance clerk')).toBeInTheDocument();
  });

  it('shows no Role portfolios tab to someone who answers for none', async () => {
    mount();
    await screen.findByRole('tab', { name: /Applications/ });
    expect(screen.queryByRole('tab', { name: /Role portfolios/ })).toBeNull();
  });

  it('a tab opens its first tree', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('tab', { name: /Applications/ }));
    expect(await screen.findByRole('heading', { name: 'Azure', level: 2 })).toBeInTheDocument();
    expect(tree().queryByText('CTO unit')).toBeNull();
  });
});

describe('ownerPageTabs / ownerActiveTab: one row of tabs', () => {
  const TABS = [{ key: 'OrganizationalUnit', label: 'Organisation' }, { key: 'LogicalApplication', label: 'Applications' }];
  const ready = { ready: true, tabs: TABS, active: 'LogicalApplication' };
  const none = { ready: false, tabs: [], active: 'OrganizationalUnit' };

  it('is just the tree tabs for an owner with no business roles, and nothing without a tree', () => {
    expect(ownerPageTabs(ready, false)).toBe(TABS);
    expect(ownerPageTabs(none, false)).toEqual([]);
  });

  it('puts Business roles last, after the tree tabs or the plain units tab', () => {
    expect(ownerPageTabs(ready, true).map(t => t.label)).toEqual(['Organisation', 'Applications', 'Business roles']);
    expect(ownerPageTabs(none, true)).toEqual([{ key: UNITS_TAB, label: 'Your units' }, { key: ROLES_TAB, label: 'Business roles' }]);
  });

  it('lights Business roles while they are open, else the tree tab, else the units tab', () => {
    expect(ownerActiveTab(ready, true)).toBe(ROLES_TAB);
    expect(ownerActiveTab(ready, false)).toBe('LogicalApplication');
    expect(ownerActiveTab(none, false)).toBe(UNITS_TAB);
  });
});

describe('ownerTreeView', () => {
  it('puts a selected sub-unit on the tab of its tree', () => {
    const view = ownerTreeView(FOREST, DEV, 'LogicalApplication');
    expect(view.active).toBe('OrganizationalUnit');
    expect(view.nodes.map(n => n.id)).toEqual([CTO]);
  });

  it('follows the chosen tab when nothing in the tree is selected', () => {
    expect(ownerTreeView(FOREST, 'elsewhere', 'LogicalApplication').active).toBe('LogicalApplication');
    expect(ownerTreeView(FOREST, null, null).active).toBe('OrganizationalUnit');
  });

  it('has no tabs for an empty tree', () => {
    expect(ownerTreeView([], null, null).tabs).toEqual([]);
  });
});
