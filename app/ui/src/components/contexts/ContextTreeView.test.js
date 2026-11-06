// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderWithProviders, screen, within, userEvent } from '@ui/test-utils/renderWithProviders';
import ContextTreeView from './ContextTreeView';

// The prefix-stripping helpers are covered by ContextTreeView.prefix.test.js;
// this mounts the tree and pins what a row offers, editable or not.
const leaf = (id, displayName, extra = {}) => ({
  id, displayName, variant: 'manual', targetType: 'Identity', directMemberCount: 0, totalMemberCount: 0, children: [], ...extra,
});
const TAGS_PEOPLE = leaf('t-ppl', 'Tags', { directMemberCount: 2, totalMemberCount: 5, children: [leaf('vip', 'VIP')] });
const TAGS_ACC = leaf('t-acc', 'Tags', { targetType: 'Principal', directMemberCount: 1, totalMemberCount: 1 });

const chip = (name) => screen.getAllByRole('button').find(b => b.closest('li') && !b.hasAttribute('aria-expanded') && !b.hasAttribute('aria-haspopup') && b.textContent.startsWith(name));

function mount(props = {}) {
  renderWithProviders(h(ContextTreeView, { nodes: [TAGS_PEOPLE, TAGS_ACC], onSelect: vi.fn(), ...props }));
  return userEvent.setup();
}

describe('ContextTreeView — a reading tree (no edit callbacks)', () => {
  it('offers no add, no rename and no tooltip promising either', async () => {
    const user = mount();
    expect(screen.queryByRole('button', { name: 'Add a sub-unit' })).toBeNull();
    expect(chip('VIP')).not.toHaveAttribute('title');
    await user.dblClick(chip('VIP'));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('names a root\'s kind after its name when the page asks (three roots called "Tags")', () => {
    mount({ rootSuffix: (n) => (n.targetType === 'Identity' ? 'People' : 'Accounts') });
    expect(chip('Tags · People')).toBeInTheDocument();
    expect(chip('Tags · Accounts')).toBeInTheDocument();
    // Only roots get the suffix.
    expect(chip('VIP').textContent).not.toContain('·');
  });

  it('draws the root actions on root rows only', () => {
    mount({ renderRootActions: (n) => h('button', { 'aria-haspopup': 'menu' }, `menu ${n.id}`) });
    expect(screen.getAllByRole('button', { name: /^menu / }).map(b => b.textContent)).toEqual(['menu t-ppl', 'menu t-acc']);
  });

  it('loads a unit\'s members on demand, in the kind\'s own words', async () => {
    let resolve;
    const onLoadMembers = vi.fn(() => new Promise(r => { resolve = r; }));
    const user = mount({ onLoadMembers });
    const toggle = screen.getByRole('button', { name: 'Show the people directly in Tags' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(await screen.findByText('Loading people…')).toBeInTheDocument();
    resolve({ rows: [], total: 0 });
    expect(await screen.findByText('No people directly in this unit.')).toBeInTheDocument();
    expect(onLoadMembers).toHaveBeenCalledWith('t-ppl');
    // A unit without direct members has nothing to show.
    expect(screen.queryByRole('button', { name: /directly in VIP/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Show the accounts directly in Tags/ })).toHaveLength(1);
  });

  it('says how many more members there are than it drew', async () => {
    const onLoadMembers = vi.fn().mockResolvedValue({ rows: [{ id: 'u1', displayName: 'Ada' }], total: 3 });
    const onOpenMember = vi.fn();
    const user = mount({ onLoadMembers, onOpenMember });
    await user.click(screen.getByRole('button', { name: 'Show the people directly in Tags' }));
    expect(await screen.findByText('+2 more — select the unit to see all')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ada' }));
    expect(onOpenMember).toHaveBeenCalledWith('u1', 'Ada', 'identity');
  });
});

describe('ContextTreeView — an editable tree', () => {
  const editable = { onReparent: vi.fn(), onRename: vi.fn(), onAddChild: vi.fn() };

  it('explains rename and move on a child, rename only on a root (a root has no parent to change)', () => {
    mount(editable);
    expect(chip('VIP')).toHaveAttribute('title', 'Double-click to rename · drag onto another unit to move it there');
    expect(chip('Tags')).toHaveAttribute('title', 'Double-click to rename');
    expect(chip('VIP')).not.toHaveAttribute('aria-disabled');
    expect(chip('Tags')).not.toHaveAttribute('aria-disabled');
  });

  it('renames on double-click and adds a sub-unit from +', async () => {
    const onRename = vi.fn();
    const onAddChild = vi.fn();
    const user = mount({ ...editable, onRename, onAddChild });
    await user.dblClick(chip('VIP'));
    const input = screen.getByRole('textbox', { name: 'Unit name' });
    await user.clear(input);
    await user.type(input, 'VIPs{Enter}');
    expect(onRename).toHaveBeenCalledWith('vip', 'VIPs');

    const row = chip('VIP').closest('div');
    await user.click(within(row).getByRole('button', { name: 'Add a sub-unit' }));
    await user.type(screen.getByRole('textbox', { name: 'New sub-unit name…' }), 'Gold{Enter}');
    expect(onAddChild).toHaveBeenCalledWith('vip', 'Gold');
  });
});
