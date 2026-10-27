// @vitest-environment jsdom
// The workbench with people as columns — the default, the matrix's orientation:
// the business role with its entitlements nested, then Other access; what is
// known of people as header rows with the same filter and sort; the same cells,
// selection and candidate as with people as rows. jsdom has no layout, so the
// virtualiser is replaced by one that renders every row.
import { describe, it, expect, vi } from 'vitest';
import { screen, within, waitFor } from '@ui/test-utils/renderWithProviders';
import { mount } from '@ui/test-utils/workbenchFixture';

// Organisation knowledge on: the workbench is part of it.
vi.mock('@ui/hooks/useOrgKnowledge', () => ({ useOrgKnowledge: () => true }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * estimateSize(), end: (index + 1) * estimateSize() })),
    getTotalSize: () => count * estimateSize(),
  }),
}));

const grid = () => screen.getByRole('table', { name: "Access of the unit's people, people as columns" });
const opened = () => screen.findByRole('heading', { name: 'Claims Handling' }, { timeout: 5000 });
const rowNames = () => [...grid().querySelectorAll('tbody tr')].map(tr => tr.querySelector('th')?.textContent.trim()).filter(Boolean);
// The names row: the last header row above the permission headers.
const personNames = () => [...[...grid().querySelectorAll('thead tr')].at(-2).querySelectorAll('th[scope="col"]')].map(th => th.textContent.trim());
const candidate = () => screen.getByRole('complementary', { name: 'Candidate role' });

describe('people as columns', () => {
  it('opens in the matrix orientation: the role with its entitlements under it, then Other access; people as columns', async () => {
    mount();
    await opened();
    expect(screen.getByRole('button', { name: 'People as columns' })).toHaveAttribute('aria-pressed', 'true');
    // No grouping with people as columns.
    expect(screen.queryByText('Group by')).toBeNull();
    expect(rowNames()).toEqual(['▾Claims handler2 entitlements', 'ClaimsSuite Read', 'Motor handler', 'Other access · 1 not in any role shown', 'WorksCouncil site']);
    expect(personNames()).toEqual(['Anna Vos', 'Bram Smit', 'Cleo Kok']);
    // The header rows: the attributes chosen, the name last.
    const labels = [...grid().querySelectorAll('thead th[scope="row"]')].map(th => th.textContent.replace(/▾/g, '').trim());
    expect(labels).toEqual(['Job title', 'Activity', 'Expertise', 'Duty', 'Display name']);
    // Nobody has an expertise: that row stays one line high.
    expect([...grid().querySelectorAll('thead tr[data-empty]')].map(tr => tr.querySelector('th').textContent.replace(/▾/g, '').trim())).toEqual(['Expertise']);
  });

  it('shows the matrix cell under each person, and the role held in its own row', async () => {
    mount();
    await opened();
    const read = screen.getByRole('button', { name: /^Select the row ClaimsSuite Read/ }).closest('tr');
    // Anna D (through the role), Bram D and Cleo E — held outside the role that contains it (the matrix's red 1).
    expect([...read.querySelectorAll('td')].slice(4).map(td => td.textContent)).toEqual(['D', 'D1', 'E1']);
    const role = grid().querySelector('tr[data-role="br"]');
    expect(role).toHaveTextContent('Business role');
    expect(role.querySelectorAll('td')[1]).toHaveTextContent('1');
  });

  it('folds a role\'s entitlements away and back', async () => {
    const { user } = mount();
    await opened();
    await user.click(screen.getByRole('button', { name: 'Fold Claims handler' }));
    expect(rowNames()).not.toContain('Motor handler');
    await user.click(screen.getByRole('button', { name: 'Unfold Claims handler' }));
    expect(rowNames()).toContain('Motor handler');
  });

  it('sorts the people columns from a header row and filters them like Excel', async () => {
    const { user } = mount();
    await opened();
    await user.click(screen.getByRole('button', { name: 'Sort by Display name' }));
    await user.click(screen.getByRole('button', { name: 'Sort by Display name' }));
    expect(personNames()).toEqual(['Cleo Kok', 'Bram Smit', 'Anna Vos']);
    await user.click(screen.getByRole('button', { name: 'Filter Duty' }));
    const menu = screen.getByRole('dialog', { name: /Filter Duty/ });
    await user.click(within(menu).getByRole('button', { name: 'None' }));
    await user.click(within(menu).getByRole('checkbox', { name: /Works council member/ }));
    await user.click(within(menu).getByRole('button', { name: 'OK' }));
    expect(personNames()).toEqual(['Bram Smit']);
  });

  it('shows knowledge compactly — ✓ / ? and +N — and opens its evidence', async () => {
    const { user } = mount();
    await opened();
    const bram = screen.getByRole('button', { name: /^Activity of Bram Smit/ });
    expect(bram).toHaveTextContent('? Handle claims');
    await user.click(bram);
    const pop = screen.getByRole('dialog', { name: 'Activity of Bram Smit' });
    await user.click(within(pop).getByRole('button', { name: /Activity: Handle claims/ }));
    expect(within(pop).getByRole('dialog', { name: 'Evidence for Handle claims' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Duty of Bram Smit/ })).toHaveTextContent('✓ Works council member');
  });

  it('selects a person\'s or a resource\'s held cells and adds them to the candidate, as with people as rows', async () => {
    const { user } = mount();
    await opened();
    // Cleo's name: what she holds — ClaimsSuite Read (E) and Motor handler (D).
    await user.click(within(grid()).getByTitle(/^Cleo Kok Select/));
    await waitFor(() => expect(screen.getByRole('toolbar', { name: 'Selection' })).toHaveTextContent('2 cells · 1 person'));
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    // A resource's name: what the people shown hold of it.
    await user.click(screen.getByRole('button', { name: /^Select the row Motor handler/ }));
    expect(screen.getByRole('toolbar', { name: 'Selection' })).toHaveTextContent('2 cells · 2 people');
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    await user.click(within(grid()).getByTitle(/^Cleo Kok Select/));
    await user.click(screen.getByRole('button', { name: 'Add to candidate' }));
    expect(within(candidate()).getByText('Entitlements (2)')).toBeInTheDocument();
    // The candidate shows as a Draft role row with what it contains under it.
    expect(rowNames().some(n => n.startsWith('▾Draft'))).toBe(true);
  });

  it('remembers the orientation in the view: switching to people as rows shows the other grid', async () => {
    const { user } = mount();
    await opened();
    await user.click(screen.getByRole('button', { name: 'People as rows' }));
    expect(screen.getByRole('table', { name: "Access of the unit's people" })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: "Access of the unit's people, people as columns" })).toBeNull();
    expect(screen.getByText('Group by')).toBeInTheDocument();
  });
});

describe('filtering the permissions', () => {
  const strip = () => screen.getByRole('region', { name: 'Permission filters' });

  it('hides everything in a logical application — its modules too — and says so under the role', async () => {
    const { user } = mount();
    await opened();
    await user.click(screen.getByRole('button', { name: 'Filter Contexts' }));
    const menu = screen.getByRole('dialog', { name: 'Filter Contexts' });
    await user.click(within(menu).getByRole('radio', { name: 'Hide resources in these' }));
    // Hiding starts with nothing ticked; the module Motor sits under ClaimsSuite.
    expect(within(menu).getAllByRole('checkbox').filter(c => c.checked)).toHaveLength(0);
    await user.click(within(menu).getByRole('checkbox', { name: /^ClaimsSuite\s*2$/ }));
    await user.click(within(menu).getByRole('button', { name: 'OK' }));
    expect(rowNames()).toEqual(['▾Claims handler(all hidden by filters)', 'Other access · 1 not in any role shown', 'WorksCouncil site']);
    expect(strip()).toHaveTextContent('1 of 3 permissions shown');
    expect(strip()).toHaveTextContent('Contexts: hiding ClaimsSuite');
    await user.click(within(strip()).getByRole('button', { name: 'Clear permission filters' }));
    expect(rowNames()).toContain('Motor handler');
  });

  it('filters by type and sorts the permissions by held by', async () => {
    const { user } = mount();
    await opened();
    await user.click(screen.getByRole('button', { name: 'Filter Type' }));
    const menu = screen.getByRole('dialog', { name: 'Filter Type' });
    await user.click(within(menu).getByRole('checkbox', { name: /^Group/ }));
    await user.click(within(menu).getByRole('button', { name: 'OK' }));
    expect(rowNames()).toEqual(['▾Claims handler2 entitlements', 'ClaimsSuite Read', 'Motor handler']);
    await user.click(within(strip()).getByRole('button', { name: 'Clear the Type filter' }));
    await user.click(screen.getByRole('button', { name: 'Sort by Held by' }));
    expect(rowNames()).toEqual(['▾Claims handler2 entitlements', 'Motor handler', 'ClaimsSuite Read', 'Other access · 1 not in any role shown', 'WorksCouncil site']);
  });

  it('hides what one person alone holds in one click, and spots outliers with at most', async () => {
    const { user } = mount();
    await opened();
    await user.click(screen.getByRole('button', { name: 'Hide permissions only one person holds' }));
    expect(rowNames()).not.toContain('WorksCouncil site');
    expect(screen.queryByRole('button', { name: 'Hide permissions only one person holds' })).toBeNull();
    await user.type(screen.getByRole('spinbutton', { name: 'Access held by at most' }), '2');
    expect(rowNames()).toEqual(['▾Claims handler1 entitlement · 1 hidden by filters', 'Motor handler']);
  });

  it('keeps a proposed role\'s hidden entitlement, marked, and leaves it out of the impact', async () => {
    const { user } = mount();
    await opened();
    await user.click(within(grid()).getByTitle(/^Cleo Kok Select/));
    await user.click(screen.getByRole('button', { name: 'Add to candidate' }));
    await user.click(screen.getByRole('button', { name: 'Filter Resource name' }));
    const menu = screen.getByRole('dialog', { name: 'Filter Resource name' });
    await user.click(within(menu).getByRole('checkbox', { name: /^Motor handler/ }));
    await user.click(within(menu).getByRole('button', { name: 'OK' }));
    // Under the existing role it is gone; under the proposed one it stays, marked.
    const hidden = grid().querySelector('tbody tr[data-hidden-by-filter]');
    expect(hidden).toHaveTextContent('Motor handlerhidden by filter');
    expect(rowNames().filter(n => n.startsWith('Motor handler'))).toHaveLength(1);
    expect(candidate()).toHaveTextContent('1 permission hidden by filters — not counted.');
  });

  it('with people as rows, the same filters sit behind a Permissions menu', async () => {
    const { user } = mount();
    await opened();
    await user.click(screen.getByRole('button', { name: 'People as rows' }));
    await user.click(screen.getByRole('button', { name: 'Permissions ▾' }));
    const panel = screen.getByRole('dialog', { name: 'Filter the permissions' });
    await user.click(within(panel).getByRole('button', { name: 'Filter System' }));
    const menu = screen.getByRole('dialog', { name: 'Filter System' });
    await user.click(within(menu).getByRole('checkbox', { name: /^CS/ }));
    await user.click(within(menu).getByRole('button', { name: 'OK' }));
    const headers = within(screen.getByRole('table', { name: "Access of the unit's people" })).getAllByRole('button', { name: /^Select the column/ }).map(b => b.textContent);
    expect(headers).toEqual(['WorksCouncil site']);
    expect(screen.getByRole('button', { name: 'Permissions (1) ▾' })).toBeInTheDocument();
  });
});
