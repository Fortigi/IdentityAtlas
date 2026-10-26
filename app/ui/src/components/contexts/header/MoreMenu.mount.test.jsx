// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement as h } from 'react';
import MoreMenu from './MoreMenu';
import { matrixHrefForUnit } from '@ui/utils/matrixFilter';
import { renderWithProviders, makeAuthFetch, screen, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

// The header's ⋯ menu: every action but the main ones, each only when given.

const ATTRS = { id: 'ctx-7', displayName: 'Harbour Office', contextCategory: 'OrganizationalUnit', targetType: 'Principal' };
const RESOLVE = '/api/context-trees/resolve?contextId=ctx-7';

function mount(props = {}) {
  const authFetch = makeAuthFetch({ [RESOLVE]: { treeKey: 'tree:1', name: 'Customers', canAdjust: true } });
  const result = renderWithProviders(h(MoreMenu, { attrs: ATTRS, ...props }), { auth: { authFetch } });
  return { ...result, authFetch, user: userEvent.setup() };
}
const items = () => screen.getAllByRole('menuitem').map(i => i.textContent);

afterEach(() => { vi.restoreAllMocks(); });

describe('MoreMenu', () => {
  it('renders nothing when there is nothing to offer', () => {
    const { container } = mount();
    expect(container).toBeEmptyDOMElement();
  });

  it('lists the given items in a fixed order, and gives the first the focus', async () => {
    const all = {
      matrix: true, onAdjustTree: vi.fn(), onEditRecipe: vi.fn(), onEdit: vi.fn(), onAddSubUnit: vi.fn(),
      copyLink: true, onOpenAsPage: vi.fn(), onClose: vi.fn(),
    };
    const { user } = mount(all);
    const trigger = screen.getByRole('button', { name: 'More actions' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(items()).toEqual(['View in matrix ↗', 'Adjust tree', 'Edit search terms', 'Edit', 'Add sub-unit', 'Copy link', 'Open as page', 'Back to Contexts']));
    expect(screen.getByRole('menuitem', { name: 'View in matrix ↗' })).toHaveFocus();
  });

  it('with fewer items, the first given one takes the focus', async () => {
    const { user } = mount({ onEdit: vi.fn(), copyLink: true });
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(items()).toEqual(['Edit', 'Copy link']);
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus();
  });

  it('runs a choice once and closes the menu', async () => {
    const onEdit = vi.fn();
    const onAddSubUnit = vi.fn();
    const { user } = mount({ onEdit, onAddSubUnit });
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Add sub-unit' }));
    expect(onAddSubUnit).toHaveBeenCalledTimes(1);
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Escape closes it and gives the focus back to the button', async () => {
    const { user } = mount({ onEdit: vi.fn() });
    const trigger = screen.getByRole('button', { name: 'More actions' });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('opens the matrix scoped to the unit in a new tab', async () => {
    const { user } = mount({ matrix: true });
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    const link = screen.getByRole('menuitem', { name: 'View in matrix ↗' });
    expect(link).toHaveAttribute('href', matrixHrefForUnit(ATTRS));
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('Adjust tree opens the tree the API resolves', async () => {
    const onAdjustTree = vi.fn();
    const { user, authFetch } = mount({ onAdjustTree });
    expect(authFetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    const item = screen.getByRole('menuitem', { name: /Adjust tree/ });
    await waitFor(() => expect(item).not.toHaveAttribute('aria-disabled'));
    await user.click(item);
    expect(onAdjustTree).toHaveBeenCalledWith('tree:1', 'Adjust: Customers');
    expect(authFetch).toHaveBeenCalledWith(RESOLVE);
  });

  it('Copy link copies this unit\'s link and says so; a refused clipboard says it could not', async () => {
    const writeText = vi.fn(async () => {});
    const { user } = mount({ copyLink: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}${window.location.pathname}#context:ctx-7`);
    expect(await screen.findByText('Link copied')).toBeInTheDocument();

    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied'); }) }, configurable: true });
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Copy link' }));
    expect(await screen.findByText('Could not copy the link')).toBeInTheDocument();
  });
});
