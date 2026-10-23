// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement as h } from 'react';
import ContextsPage from './ContextsPage';
import { renderWithProviders, makeAuthFetch, screen, within, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

beforeEach(() => { sessionStorage.clear(); });

// One root per place it can land: three organisation trees (one of each kind),
// an application, a tag, a segment, and one without a template.
const root = (id, displayName, contextCategory, targetType) => ({
  id, displayName, contextCategory, targetType, variant: 'manual', contextType: 'Manual', directMemberCount: 1, totalMemberCount: 1,
});
const ROOTS = [
  root('ou-ppl', 'Finance people', 'OrganizationalUnit', 'Identity'),
  root('ou-acc', 'Finance accounts', 'OrganizationalUnit', 'Principal'),
  root('ou-res', 'Finance shares', 'OrganizationalUnit', 'Resource'),
  root('app', 'SAP', 'LogicalApplication', 'Resource'),
  root('tag', 'PCI', 'Tag', 'Resource'),
  root('seg', 'Amsterdam', 'Segment', 'Identity'),
  root('odd', 'Legacy cluster', null, 'Identity'),
];

// The subtree of whichever root is asked for: the root with one child named
// after it, so the left tree shows which tree is open; and each root's detail
// for the right pane.
function api(roots = ROOTS) {
  return makeAuthFetch((url) => {
    const u = String(url);
    const m = /\/api\/contexts\/tree\?root=([^&]+)/.exec(u);
    if (m) {
      const r = roots.find(x => x.id === decodeURIComponent(m[1]));
      return [{ ...r, children: [{ ...r, id: `${r.id}-child`, displayName: `${r.displayName} / child`, children: [] }] }];
    }
    if (u === '/api/contexts') return { data: roots };
    const d = /^\/api\/contexts\/([^/?]+)$/.exec(u);
    const hit = d && roots.find(x => x.id === decodeURIComponent(d[1]));
    if (hit) return { attributes: hit, subContexts: [] };
    return undefined;
  });
}

function mount(roots) {
  const authFetch = api(roots);
  renderWithProviders(h(ContextsPage, {}), { auth: { authFetch } });
  return { authFetch, user: userEvent.setup() };
}

const tab = (name) => screen.getByRole('tab', { name: new RegExp(`^${name}`) });
const selector = () => screen.getByTestId('context-tree-pane');
// The context the right pane shows: its header's heading.
const shown = () => within(screen.getByTestId('context-detail-pane')).getByRole('heading', { level: 2 }).textContent;

describe('ContextsPage — a sub-tab per template', () => {
  it('shows the four templates and Other without counts, opening on Organisation · People', async () => {
    mount();
    expect(await screen.findByText('Finance people / child')).toBeInTheDocument();
    // The first tab list is the template tabs (the shown context has its own below).
    expect(within(screen.getAllByRole('tablist')[0]).getAllByRole('tab').map(t => t.textContent)).toEqual(['Organisation', 'Applications', 'Tags', 'Segments', 'Other']);
    expect(tab('Organisation')).toHaveAttribute('aria-selected', 'true');
    // Only the people trees are listed; accounts and resources trees wait behind the switch.
    // The people tree's root is a node of the tree (and names the tree-actions bar).
    expect(within(selector()).getByRole('button', { name: /^Finance people(?! \/)/ })).toHaveAttribute('aria-current', 'true');
    expect(within(selector()).queryByText('Finance accounts')).toBeNull();
    expect(within(selector()).queryByText('SAP')).toBeNull();
  });

  it('switches the organisation tree kind between People, Accounts and Resources', async () => {
    const { authFetch, user } = mount();
    await screen.findByText('Finance people / child');
    // The switch sits in the tree panel's header, not beside the template tabs.
    const kinds = within(selector()).getByRole('group', { name: 'Show' });
    expect(within(kinds).getAllByRole('button').map(b => b.textContent)).toEqual(['People', 'Accounts', 'Resources']);
    expect(within(kinds).getByRole('button', { name: 'People' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(within(kinds).getByRole('button', { name: 'Accounts' }));
    expect(await screen.findByText('Finance accounts / child')).toBeInTheDocument();
    expect(within(selector()).queryByText('Finance people')).toBeNull();
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/tree?root=ou-acc');

    await user.click(within(kinds).getByRole('button', { name: 'Resources' }));
    expect(await screen.findByText('Finance shares / child')).toBeInTheDocument();
  });

  it('lists application roots on Applications, and the tag and segment trees as before', async () => {
    const { user } = mount();
    await screen.findByText('Finance people / child');

    await user.click(tab('Applications'));
    expect(await screen.findByText('SAP / child')).toBeInTheDocument();
    // The kind switch belongs to Organisation only.
    expect(screen.queryByRole('group', { name: 'Show' })).toBeNull();
    // An application always holds resources: no kind filter either.
    expect(screen.queryByRole('combobox', { name: 'Filter by kind' })).toBeNull();
    expect(within(selector()).queryByText('Finance people')).toBeNull();

    await user.click(tab('Tags'));
    expect(await screen.findByText('PCI / child')).toBeInTheDocument();
    await user.click(tab('Segments'));
    expect(await screen.findByText('Amsterdam / child')).toBeInTheDocument();
    await user.click(tab('Other'));
    expect(await screen.findByText('Legacy cluster / child')).toBeInTheDocument();
  });

  it('leaves Other out when every root has a template, and opens on the first tab with trees', async () => {
    mount(ROOTS.filter(r => r.contextCategory === 'Tag' || r.contextCategory === 'Segment'));
    expect(await screen.findByText('PCI / child')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^Other/ })).toBeNull();
    expect(tab('Tags')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Organisation').textContent).toBe('Organisation');
  });

  it('opens on the first kind that has trees, offering no empty kind to land on', async () => {
    mount(ROOTS.filter(r => r.id === 'ou-acc' || r.id === 'ou-res'));
    expect(await screen.findByText('Finance accounts / child')).toBeInTheDocument();
    const kinds = within(selector()).getByRole('group', { name: 'Show' });
    expect(within(kinds).getAllByRole('button').map(b => b.textContent)).toEqual(['Accounts', 'Resources']);
    expect(within(kinds).getByRole('button', { name: 'Accounts' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('with a single kind, names it rather than offering a switch', async () => {
    mount(ROOTS.filter(r => r.id === 'ou-acc'));
    expect(await screen.findByText('Finance accounts / child')).toBeInTheDocument();
    expect(within(selector()).queryByRole('group', { name: 'Show' })).toBeNull();
    expect(within(selector()).getByText('Show:').parentElement).toHaveTextContent('Show:Accounts');
  });

  it('names the kind of each Tags root, so three roots called "Tags" can be told apart', async () => {
    const tags = [
      root('tag-ppl', 'Tags', 'Tag', 'Identity'),
      root('tag-acc', 'Tags', 'Tag', 'Principal'),
      root('tag-res', 'Tags', 'Tag', 'Resource'),
    ];
    const { user } = mount(tags);
    await screen.findByText('Tags / child');
    const roots = within(selector()).getAllByRole('button', { name: /^Tags · / }).map(b => b.textContent.split(',')[0]);
    expect(roots).toEqual(['Tags · People', 'Tags · Accounts', 'Tags · Resources']);
    // The kind filter, in words, narrows to one of them.
    await user.selectOptions(within(selector()).getByRole('combobox', { name: 'Filter by kind' }), 'Principal');
    expect(within(selector()).getAllByRole('button', { name: /^Tags · / }).map(b => b.textContent.split(',')[0])).toEqual(['Tags · Accounts']);
    // Its ⋯ menu is named after the tree with its kind, not just "Tags".
    expect(within(selector()).getByRole('button', { name: 'Actions for Tags · Accounts' })).toBeInTheDocument();
  });

  it('every tab has the same two panes: its tree on the left, its first root shown on the right', async () => {
    const { user } = mount();
    await waitFor(() => expect(shown()).toBe('Finance people'));
    for (const [name, root] of [['Applications', 'SAP'], ['Tags', 'PCI'], ['Segments', 'Amsterdam'], ['Other', 'Legacy cluster']]) {
      await user.click(tab(name));
      await waitFor(() => expect(shown()).toBe(root));
      expect(await within(selector()).findByText(`${root} / child`)).toBeInTheDocument();
    }
  });

  it('selects a node in place on a non-Organisation tab and remembers it per tab', async () => {
    const onOpenDetail = vi.fn();
    renderWithProviders(h(ContextsPage, { onOpenDetail }), { auth: { authFetch: api() } });
    const user = userEvent.setup();
    await screen.findByText('Finance people / child');
    await user.click(tab('Applications'));
    const childChip = (await within(selector()).findByText('SAP / child')).closest('button');
    await user.click(childChip);
    await waitFor(() => expect(childChip).toHaveAttribute('aria-current', 'true'));
    expect(onOpenDetail).not.toHaveBeenCalled();
    // Away and back: the application tab kept its selection.
    await user.click(tab('Tags'));
    await waitFor(() => expect(shown()).toBe('PCI'));
    await user.click(tab('Applications'));
    await waitFor(() => expect(within(selector()).getByText('SAP / child').closest('button')).toHaveAttribute('aria-current', 'true'));
  });

  it('shows the empty prompt on a tab without trees', async () => {
    const { user } = mount(ROOTS.filter(r => r.id === 'ou-ppl'));
    await screen.findByText('Finance people / child');
    await user.click(tab('Segments'));
    await waitFor(() => expect(screen.getByText('Pick a unit on the left.')).toBeInTheDocument());
    expect(within(selector()).getByText(/^No segments yet./)).toBeInTheDocument();
  });
});
