// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement as h } from 'react';
import ContextsPage from './ContextsPage';
import {
  renderWithProviders,
  makeAuthFetch,
  jsonResponse,
  screen,
  within,
  waitFor,
  userEvent,
} from '@ui/test-utils/renderWithProviders';

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });

// Three organisation roots: a generated people tree from the manager-hierarchy
// rule (selectable, deletable, refreshable), a synced people tree (read-only:
// the next import would overwrite an edit) and an accounts tree — the
// generated tree's variant.
const GEN = {
  id: 'root-gen', displayName: 'Engineering Org', variant: 'generated', targetType: 'Identity',
  contextType: 'ManagerHierarchy', contextCategory: 'OrganizationalUnit',
  sourceAlgorithmName: 'manager-hierarchy', sourceAlgorithmDisplayName: 'Manager Hierarchy',
  scopeSystemId: 5, scopeSystemName: 'Entra ID',
  directMemberCount: 1, totalMemberCount: 4,
};
const SYNCED = {
  id: 'root-synced', displayName: 'Sales OUs', variant: 'synced', targetType: 'Identity',
  contextType: 'OrgUnit', contextCategory: 'OrganizationalUnit', scopeSystemId: 3, scopeSystemName: 'Active Directory',
  directMemberCount: 2, totalMemberCount: 9,
  // The owner as the read endpoint hands it over: the raw value the source
  // gave, plus the principal it resolved to.
  ownerUserId: 'IIQ-4711', ownerPrincipalId: 'p-owner', ownerDisplayName: 'Leo M. Cohen',
};
const ACC = {
  id: 'root-acc', displayName: 'Engineering Org', variant: 'generated', targetType: 'Principal',
  contextType: 'ManagerHierarchy', contextCategory: 'OrganizationalUnit', directMemberCount: 7, totalMemberCount: 7,
};
// GEN is listed first by the API; the panel still lists the imported tree first.
const ROOTS = [GEN, SYNCED, ACC];

const child = (id, displayName, extra = {}) => ({
  id, displayName, variant: 'generated', targetType: 'Identity', contextType: 'ManagerHierarchy',
  contextCategory: 'OrganizationalUnit', directMemberCount: 2, totalMemberCount: 2, children: [], ...extra,
});
const BACKEND = child('child-backend', 'Backend Squad');
const FRONTEND = child('child-frontend', 'Frontend Squad', { directMemberCount: 1, totalMemberCount: 1 });
const EMEA = child('child-emea', 'EMEA Sales', { variant: 'synced' });

// /api/contexts/tree?root=<id> answers an ARRAY holding the root with children.
const SUBTREES = {
  'root-gen': [{ ...GEN, children: [BACKEND, FRONTEND] }],
  'root-synced': [{ ...SYNCED, children: [EMEA] }],
  'root-acc': [{ ...ACC, children: [] }],
};
const ALL = Object.fromEntries([...ROOTS, BACKEND, FRONTEND, EMEA].map(c => [c.id, c]));
// The generated people tree is the same unit as the accounts tree.
const RELATIONSHIPS = {
  'root-gen': [{ relationshipType: 'SameUnitAs', relatedContextId: 'root-acc', relatedDisplayName: 'Engineering Org', relatedTargetType: 'Principal', relatedTotalMemberCount: 7 }],
  'root-acc': [{ relationshipType: 'SameUnitAs', relatedContextId: 'root-gen', relatedDisplayName: 'Engineering Org', relatedTargetType: 'Identity', relatedTotalMemberCount: 4 }],
};
const MEMBERS = { total: 1, data: [{ id: 'u-1', displayName: 'Ada Lovelace', principalType: 'User' }] };

// The API: roots, subtrees, one detail per context and its sub-resources.
// `answer(url, opts)` handles a route first; undefined falls through.
function api({ roots = ROOTS, answer = () => undefined } = {}) {
  return makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    const hit = answer(u, opts);
    if (hit !== undefined) return hit;
    const tree = /^\/api\/contexts\/tree\?root=([^&]+)/.exec(u);
    if (tree) return SUBTREES[decodeURIComponent(tree[1])] || [];
    if (u === '/api/contexts') return { data: roots };
    const m = /^\/api\/contexts\/([^/?]+)(\/[^?]*)?/.exec(u);
    if (!m) return undefined;
    const [, id, sub] = m;
    if (!sub) return ALL[id] ? { attributes: ALL[id], subContexts: [] } : undefined;
    if (sub === '/members') return MEMBERS;
    if (sub === '/relationships') return RELATIONSHIPS[id] || [];
    if (sub === '/roles') return [];
    return undefined;
  });
}

// A reader: signed in, may read contexts but not change them.
const READER = { hasWildcard: false, permissions: new Set(['data.read.contexts']) };

// `select` = the people tree the session remembers as selected (null = none,
// so the page opens on the first tree it lists).
function mount({ onOpenDetail = vi.fn(), select = 'root-gen', auth = {}, ...opts } = {}) {
  if (select) sessionStorage.setItem('iatlas.contexts.selected', JSON.stringify({ 'OrganizationalUnit:Identity': select }));
  const authFetch = api(opts);
  renderWithProviders(h(ContextsPage, { onOpenDetail }), { auth: { authFetch, ...auth } });
  return { authFetch, onOpenDetail, user: userEvent.setup() };
}

const detailPane = () => screen.getByTestId('context-detail-pane');
const pane = () => screen.getByTestId('context-tree-pane');
// The context the right pane shows: its header's heading.
const shownContext = async (name) => {
  await waitFor(() => expect(within(detailPane()).getByRole('heading', { level: 2 })).toHaveTextContent(name));
};
// A node of the left tree, by its name (the chip carries the name and the count).
const node = (name) => within(pane()).getAllByRole('button').find(b =>
  b.closest('li') && !b.hasAttribute('aria-expanded') && !b.hasAttribute('aria-haspopup') && b.textContent.startsWith(name));
// The left tree under one source heading, to keep member ovals apart from the detail's members table.
const group = (heading) => screen.getByRole('region', { name: heading });
const treeCalls = (authFetch) => authFetch.mock.calls.map(([u]) => String(u)).filter(u => u.startsWith('/api/contexts/tree'));
const menuFor = (name) => screen.queryByRole('button', { name: `Actions for ${name}` });

describe('ContextsPage — the tree on the left', () => {
  it('groups the roots under a heading per source, imported first, and drops the caption line', async () => {
    mount();
    expect(await screen.findByText('Backend Squad')).toBeInTheDocument();
    const headings = within(pane()).getAllByRole('heading', { level: 3 }).map(x => x.textContent);
    expect(headings).toEqual(['Imported · Active Directory', 'Manager hierarchy · Entra ID']);
    expect(within(group('Imported · Active Directory')).getByText('Sales OUs')).toBeInTheDocument();
    expect(within(group('Manager hierarchy · Entra ID')).getByText('Engineering Org')).toBeInTheDocument();
    expect(screen.queryByTitle('Where these trees come from')).toBeNull();
  });

  it('opens on the first tree it lists when nothing is remembered — the imported one', async () => {
    const { authFetch } = mount({ select: null });
    await shownContext('Sales OUs');
    expect(node('Sales OUs')).toHaveAttribute('aria-current', 'true');
    expect(treeCalls(authFetch)).toEqual(['/api/contexts/tree?root=root-synced']);
  });

  it('reads only the selected root\'s subtree; the other root waits collapsed', async () => {
    const { authFetch } = mount();
    expect(await screen.findByText('Backend Squad')).toBeInTheDocument();
    expect(node('Engineering Org')).toHaveAttribute('aria-current', 'true');
    await shownContext('Engineering Org');
    expect(treeCalls(authFetch)).toEqual(['/api/contexts/tree?root=root-gen']);
    expect(screen.queryByText('EMEA Sales')).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand Sales OUs' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows one count per row, split in its title, and no kind badge inside Organisation', async () => {
    mount();
    await screen.findByText('Backend Squad');
    const row = node('Engineering Org');
    expect(within(row).getByTitle('4 people (1 directly in this unit)')).toHaveTextContent('4');
    // A leaf: everyone is direct, so the title has no split.
    expect(within(node('Frontend Squad')).getByTitle('1 person')).toBeInTheDocument();
    // The direct count (1) is not drawn beside the total any more.
    expect(row.textContent).toBe('Engineering Org, 4 people (1 directly in this unit)4');
    for (const word of ['Identity', 'Principal', 'People', 'Generated', 'Synced']) {
      expect(within(pane()).queryByText(word, { selector: 'li *' })).toBeNull();
    }
  });

  it('never marks a row\'s select button aria-disabled (the drag ARIA is not spread on it)', async () => {
    mount();
    await screen.findByText('Backend Squad');
    for (const name of ['Engineering Org', 'Backend Squad', 'Sales OUs']) {
      expect(node(name)).not.toHaveAttribute('aria-disabled');
      expect(node(name)).not.toHaveAttribute('aria-roledescription');
    }
  });

  it('expanding a root reads its subtree then, and only once', async () => {
    const { authFetch, user } = mount();
    await screen.findByText('Backend Squad');
    await user.click(screen.getByRole('button', { name: 'Expand Sales OUs' }));
    expect(await screen.findByText('EMEA Sales')).toBeInTheDocument();
    expect(treeCalls(authFetch)).toEqual(['/api/contexts/tree?root=root-gen', '/api/contexts/tree?root=root-synced']);
    await user.click(screen.getByRole('button', { name: 'Collapse Sales OUs' }));
    expect(screen.queryByText('EMEA Sales')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Expand Sales OUs' }));
    expect(await screen.findByText('EMEA Sales')).toBeInTheDocument();
    expect(treeCalls(authFetch)).toHaveLength(2);
    // Expanding does not select: the right pane still shows the remembered root.
    await shownContext('Engineering Org');
  });

  it('selecting a node shows its detail on the right, without opening a tab', async () => {
    const { onOpenDetail, user } = mount();
    await screen.findByText('Backend Squad');
    await user.click(node('Backend Squad'));
    await shownContext('Backend Squad');
    expect(node('Backend Squad')).toHaveAttribute('aria-current', 'true');
    expect(node('Engineering Org')).not.toHaveAttribute('aria-current');
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it('"Open as page" opens the shown context in its own tab', async () => {
    const { onOpenDetail, user } = mount();
    await screen.findByText('Backend Squad');
    await user.click(node('Backend Squad'));
    await shownContext('Backend Squad');
    await user.click(within(detailPane()).getByRole('button', { name: 'Open as page' }));
    expect(onOpenDetail).toHaveBeenCalledWith('context', 'child-backend', 'Backend Squad');
    expect(within(detailPane()).queryByTitle('Close')).toBeNull();
  });

  it('shows the selected tree owner as a person and opens that account in a tab', async () => {
    const { onOpenDetail, user } = mount();
    await screen.findByText('Backend Squad');
    await user.click(node('Sales OUs'));
    const owner = await within(detailPane()).findByTitle('Owner id: IIQ-4711');
    expect(owner.textContent).toContain('Leo M. Cohen');
    expect(owner.textContent).not.toContain('IIQ-4711');
    await user.click(owner);
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'p-owner', 'Leo M. Cohen');
  });

  it('the Show switch sits in the panel header and remembers the selection per kind', async () => {
    const { user } = mount();
    await screen.findByText('Backend Squad');
    await user.click(node('Backend Squad'));
    await shownContext('Backend Squad');
    const kinds = within(pane()).getByRole('group', { name: 'Show' });
    // Only the kinds that have trees: no Resources here.
    expect(within(kinds).getAllByRole('button').map(b => b.textContent)).toEqual(['People', 'Accounts']);
    await user.click(within(kinds).getByRole('button', { name: 'Accounts' }));
    await waitFor(() => expect(node('Engineering Org')).toHaveAttribute('aria-current', 'true'));
    expect(screen.queryByText('Sales OUs')).toBeNull();
    await user.click(within(kinds).getByRole('button', { name: 'People' }));
    await shownContext('Backend Squad');
    expect(node('Backend Squad')).toHaveAttribute('aria-current', 'true');
  });

  it('has no List mode: the panel is the tree', async () => {
    mount();
    await screen.findByText('Backend Squad');
    expect(screen.queryByRole('button', { name: 'List' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tree' })).toBeNull();
  });
});

describe('ContextsPage — links inside the detail', () => {
  it('a variant link selects that context in place and switches the kind of tree', async () => {
    const { onOpenDetail, user } = mount();
    await shownContext('Engineering Org');
    const variants = await screen.findByTestId('unit-variants');
    await user.click(await within(variants).findByRole('button', { name: /^Accounts/ }));
    await waitFor(() => expect(within(within(pane()).getByRole('group', { name: 'Show' })).getByRole('button', { name: 'Accounts' })).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() => expect(node('Engineering Org')).toHaveAttribute('aria-current', 'true'));
    expect(screen.queryByText('Sales OUs')).toBeNull();
    expect(onOpenDetail).not.toHaveBeenCalledWith('context', expect.anything(), expect.anything());
  });
});

describe('ContextsPage — who may change a tree', () => {
  it('an imported tree offers no ⋯ menu, no add-sub-unit and no rename', async () => {
    const { authFetch, user } = mount();
    await screen.findByText('Backend Squad');
    // The derived tree beside it does.
    expect(menuFor('Engineering Org')).toBeInTheDocument();
    expect(menuFor('Sales OUs')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Expand Sales OUs' }));
    await screen.findByText('EMEA Sales');
    const synced = group('Imported · Active Directory');
    expect(within(synced).queryByRole('button', { name: 'Add a sub-unit' })).toBeNull();
    expect(within(group('Manager hierarchy · Entra ID')).getAllByRole('button', { name: 'Add a sub-unit' }).length).toBeGreaterThan(0);
    await user.dblClick(node('EMEA Sales'));
    expect(screen.queryByRole('textbox', { name: 'Unit name' })).toBeNull();
    expect(authFetch.mock.calls.some(([, o]) => o?.method === 'PATCH')).toBe(false);
  });

  it('a user without data.write.contexts gets no +, rename, ⋯, member drag or + New', async () => {
    const { user } = mount({ auth: READER });
    await screen.findByText('Backend Squad');
    expect(menuFor('Engineering Org')).toBeNull();
    expect(within(pane()).queryByRole('button', { name: 'Add a sub-unit' })).toBeNull();
    expect(within(pane()).queryByRole('button', { name: '+ New' })).toBeNull();
    await user.dblClick(node('Backend Squad'));
    expect(screen.queryByRole('textbox', { name: 'Unit name' })).toBeNull();
    // The members still open, but nobody can drag one to another team.
    await user.click(within(group('Manager hierarchy · Entra ID')).getAllByRole('button', { name: /^Show the people directly in/ })[0]);
    expect(await within(group('Manager hierarchy · Entra ID')).findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByTitle(/drag onto another team to move/)).toBeNull();
  });

  it('the same user with the permission gets them back', async () => {
    mount({ auth: { hasWildcard: false, permissions: new Set(['data.write.contexts']) } });
    await screen.findByText('Backend Squad');
    expect(menuFor('Engineering Org')).toBeInTheDocument();
    expect(within(pane()).getByRole('button', { name: '+ New' })).toBeInTheDocument();
  });
});

describe('ContextsPage — editing the tree', () => {
  const openMenu = async (user, name) => { await user.click(menuFor(name)); return screen.getByRole('menu', { name: `Actions for ${name}` }); };

  it('Delete this tree… asks first, then calls DELETE and falls back to the next tree', async () => {
    let deleted = false;
    const { authFetch, user } = mount({
      answer: (u, opts) => {
        if (opts.method === 'DELETE') { deleted = true; return jsonResponse(null, { ok: true, status: 204 }); }
        if (u === '/api/contexts' && deleted) return { data: [SYNCED, ACC] };
        return undefined;
      },
    });
    await screen.findByText('Backend Squad');
    // A manager-hierarchy tree is derived: Refresh and Delete.
    let menu = await openMenu(user, 'Engineering Org');
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Refresh', 'Delete this tree…']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete this tree…' }));
    expect(await screen.findByText(/Delete "Engineering Org" and every unit under it\?/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(authFetch.mock.calls.some(([, o]) => o?.method === 'DELETE')).toBe(false);

    menu = await openMenu(user, 'Engineering Org');
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete this tree…' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/root-gen', expect.objectContaining({ method: 'DELETE' }));
    await shownContext('Sales OUs');
  });

  it('a tree created here offers Delete but not Refresh', async () => {
    const MANUAL = { ...GEN, id: 'root-man', displayName: 'Projects', variant: 'manual', sourceAlgorithmName: null };
    const { user } = mount({ roots: [MANUAL], select: null });
    await waitFor(() => expect(menuFor('Projects')).toBeInTheDocument());
    expect(within(pane()).getByRole('heading', { level: 3 })).toHaveTextContent('Created here');
    const menu = await openMenu(user, 'Projects');
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Delete this tree…']);
  });

  it('surfaces a delete error when the API rejects', async () => {
    const { user } = mount({
      answer: (u, opts) => (opts.method === 'DELETE' ? jsonResponse({ error: 'tree is synced' }, { ok: false, status: 409 }) : undefined),
    });
    await screen.findByText('Backend Squad');
    await user.click(within(await openMenu(user, 'Engineering Org')).getByRole('menuitem', { name: 'Delete this tree…' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('tree is synced')).toBeInTheDocument();
  });

  it('Refresh re-runs the rule and re-reads the tree and the detail', async () => {
    const { authFetch, user } = mount({ answer: (u, opts) => (u.includes('/sync') && opts.method === 'POST' ? { ok: true } : undefined) });
    await shownContext('Engineering Org');
    const detailReads = () => authFetch.mock.calls.filter(([u]) => u === '/api/contexts/root-gen').length;
    const before = detailReads();
    await user.click(within(await openMenu(user, 'Engineering Org')).getByRole('menuitem', { name: 'Refresh' }));
    expect(await screen.findByText('Refreshed')).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/root-gen/sync', expect.objectContaining({ method: 'POST' }));
    expect(treeCalls(authFetch).filter(u => u.endsWith('root-gen'))).toHaveLength(2);
    await waitFor(() => expect(detailReads()).toBe(before + 1));
  });

  it('shows the API error when a refresh is refused', async () => {
    const { user } = mount({ answer: (u, opts) => (u.includes('/sync') && opts.method === 'POST' ? jsonResponse({ error: 'rule disabled' }, { ok: false, status: 409 }) : undefined) });
    await screen.findByText('Backend Squad');
    await user.click(within(await openMenu(user, 'Engineering Org')).getByRole('menuitem', { name: 'Refresh' }));
    expect(await screen.findByText('rule disabled')).toBeInTheDocument();
  });

  it('lazy-loads a node\'s members, and lets a person be dragged only in the manager-hierarchy tree', async () => {
    const { authFetch, user } = mount();
    await screen.findByText('Backend Squad');
    const mh = group('Manager hierarchy · Entra ID');
    const toggle = within(mh).getByRole('button', { name: 'Show the people directly in Engineering Org' });
    // The expander does not repeat the row's count.
    expect(toggle.textContent).not.toMatch(/\d/);
    await user.click(toggle);
    expect(await within(mh).findByTitle('Ada Lovelace — drag onto another team to move')).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/root-gen/members?limit=200');
    expect(within(mh).getByRole('button', { name: 'Hide the people directly in Engineering Org' })).toHaveAttribute('aria-expanded', 'true');

    // The imported tree beside it: its members stay put.
    await user.click(screen.getByRole('button', { name: 'Show the people directly in Sales OUs' }));
    const synced = group('Imported · Active Directory');
    expect(await within(synced).findByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(synced).queryByTitle(/drag onto another team to move/)).toBeNull();
  });

  it('enables member moves on the rule that produced the tree, not on the type name', async () => {
    const otherRule = { ...GEN, sourceAlgorithmName: 'department-tree', sourceAlgorithmDisplayName: 'Department tree' };
    const { user } = mount({ roots: [otherRule] });
    await screen.findByText('Backend Squad');
    // An unknown rule is named by its display name under "Derived".
    expect(within(pane()).getByRole('heading', { level: 3 })).toHaveTextContent('Derived · Department tree');
    await user.click(within(pane()).getByRole('button', { name: 'Show the people directly in Engineering Org' }));
    expect(await within(pane()).findByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(pane()).queryByTitle(/drag onto another team to move/)).not.toBeInTheDocument();
  });

  it('renames a node in place and re-reads the tree', async () => {
    const { authFetch, user } = mount({ answer: (u, opts) => (opts.method === 'PATCH' ? { ok: true } : undefined) });
    await screen.findByText('Backend Squad');
    await user.dblClick(node('Backend Squad'));
    const input = await screen.findByRole('textbox', { name: 'Unit name' });
    await user.clear(input);
    await user.type(input, 'Platform Squad{Enter}');
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/child-backend', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ displayName: 'Platform Squad' }),
    }));
    await waitFor(() => expect(treeCalls(authFetch).filter(u => u.endsWith('root-gen'))).toHaveLength(2));
  });

  it('adds a sub-unit under a node, inheriting its target type', async () => {
    const { authFetch, user } = mount({ answer: (u, opts) => (opts.method === 'POST' ? { id: 'new' } : undefined) });
    await screen.findByText('Backend Squad');
    const row = node('Backend Squad').closest('div');
    await user.click(within(row).getByRole('button', { name: 'Add a sub-unit' }));
    await user.type(await screen.findByRole('textbox', { name: 'New sub-unit name…' }), 'Interns{Enter}');
    const body = JSON.parse(authFetch.mock.calls.find(([u, o]) => u === '/api/contexts' && o?.method === 'POST')[1].body);
    expect(body).toEqual({ displayName: 'Interns', targetType: 'Identity', contextType: 'ManagerHierarchy', parentContextId: 'child-backend' });
  });

  it('shows the error when an edit is refused', async () => {
    const { user } = mount({ answer: (u, opts) => (opts.method === 'PATCH' ? jsonResponse({ error: 'name taken' }, { ok: false, status: 409 }) : undefined) });
    await screen.findByText('Backend Squad');
    await user.dblClick(node('Frontend Squad'));
    const input = await screen.findByRole('textbox', { name: 'Unit name' });
    await user.clear(input);
    await user.type(input, 'Backend Squad{Enter}');
    expect(await screen.findByText('name taken')).toBeInTheDocument();
  });
});

describe('ContextsPage — new tree, empty and error states', () => {
  it('opens the New Context wizard from the pane', async () => {
    const { user } = mount();
    await screen.findByText('Sales OUs');
    await user.click(screen.getByRole('button', { name: '+ New' }));
    expect(await screen.findByText('New context tree')).toBeInTheDocument();
  });

  it('shows the roots-load error branch', async () => {
    const authFetch = makeAuthFetch({ '/api/contexts': jsonResponse({ error: 'boom' }, { ok: false, status: 500 }) });
    renderWithProviders(h(ContextsPage, {}), { auth: { authFetch } });
    expect(await screen.findByText('HTTP 500')).toBeInTheDocument();
    expect(screen.getByText('Pick a unit on the left.')).toBeInTheDocument();
  });

  it('says where units come from when there are none, in plain words', async () => {
    mount({ roots: [], select: null });
    expect(await screen.findByText(/^No units yet\. Units come from an HR import or from a rule over the data\./)).toBeInTheDocument();
    expect(screen.getByText('Pick a unit on the left.')).toBeInTheDocument();
    // No kind is offered when there is none to show.
    expect(screen.queryByRole('group', { name: 'Show' })).toBeNull();
    expect(screen.queryByTestId('context-detail-pane')).toBeNull();
    expect(screen.queryByText(/plugin|synced|variant|from a crawler/i)).toBeNull();
  });
});
