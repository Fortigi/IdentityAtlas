// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement as h } from 'react';
import { renderWithProviders, makeAuthFetch, screen, within, fireEvent } from '@ui/test-utils/renderWithProviders';
import ContextTreeSelector from './ContextTreeSelector';
import { scopeSystems, filterRoots } from './ContextTreeSelector.helpers';

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });

const roots = [
  { id: 'seg', displayName: 'By location', variant: 'generated', targetType: 'Identity', sourceAlgorithmName: 'location-tree', sourceAlgorithmDisplayName: 'Location tree' },
  { id: 'other', displayName: 'Legacy clusters', variant: 'generated', targetType: 'Identity', sourceAlgorithmName: 'kmeans' },
  { id: 'app', displayName: 'Application catalogue', variant: 'synced', targetType: 'Resource', scopeSystemId: 7, scopeSystemName: 'ServiceNow' },
  { id: 'tag', displayName: 'Tag catalogue', variant: 'manual', targetType: 'Resource' },
  { id: 'hr', displayName: 'HR units', variant: 'synced', targetType: 'Identity', scopeSystemId: 3, scopeSystemName: 'Active Directory' },
];

// The tree slot renders the roots it is handed, so a test sees what passed the
// filters, group by group.
const renderTree = (list, group) => h('ul', { 'aria-label': `tree ${group.title}` }, list.map(r => h('li', { key: r.id }, r.displayName)));
const listed = () => screen.queryAllByRole('listitem').map(li => li.textContent);
const headings = () => screen.queryAllByRole('heading', { level: 3 }).map(x => x.textContent);

function mount(props = {}) {
  return renderWithProviders(
    h(ContextTreeSelector, { roots, renderTree, onOpenContext: vi.fn(), loading: false, tab: 'Segment', ...props }),
    { auth: { authFetch: makeAuthFetch({}) } },
  );
}

describe('ContextTreeSelector helpers', () => {
  it('lists each scope system once, sorted by name', () => {
    expect(scopeSystems([...roots, roots[2]])).toEqual([[3, 'Active Directory'], [7, 'ServiceNow']]);
    expect(scopeSystems(null)).toEqual([]);
  });

  it('filters on kind, source and system together', () => {
    const ids = (f) => filterRoots(roots, { target: '', variant: '', system: '', ...f }).map(r => r.id);
    expect(ids({})).toEqual(['seg', 'other', 'app', 'tag', 'hr']);
    expect(ids({ target: 'Resource' })).toEqual(['app', 'tag']);
    expect(ids({ variant: 'synced' })).toEqual(['app', 'hr']);
    expect(ids({ variant: 'synced', target: 'Identity' })).toEqual(['hr']);
    expect(ids({ system: '7' })).toEqual(['app']);
    expect(filterRoots(null, {})).toEqual([]);
  });
});

describe('ContextTreeSelector (mounted)', () => {
  it('lists the roots under a heading per source: imported per system, derived per rule, then created here', () => {
    mount({ title: 'Segments' });
    expect(screen.getByText('Segments')).toBeInTheDocument();
    expect(headings()).toEqual([
      'Imported · ServiceNow', 'Imported · Active Directory', 'Derived · Location tree', 'Derived · kmeans', 'Created here',
    ]);
    expect(within(screen.getByRole('list', { name: 'tree Created here' })).getByText('Tag catalogue')).toBeInTheDocument();
    expect(listed()).toEqual(['Application catalogue', 'HR units', 'By location', 'Legacy clusters', 'Tag catalogue']);
  });

  it('the source, system and kind filters narrow what the tree receives, in plain words', () => {
    mount();
    const source = screen.getByRole('combobox', { name: 'Filter by source' });
    expect([...source.options].map(o => o.textContent)).toEqual(['Source: All', 'Imported', 'Derived', 'Created here']);
    fireEvent.change(source, { target: { value: 'synced' } });
    expect(listed()).toEqual(['Application catalogue', 'HR units']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by system' }), { target: { value: '7' } });
    expect(listed()).toEqual(['Application catalogue']);
    fireEvent.change(source, { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by system' }), { target: { value: '' } });
    const kind = screen.getByRole('combobox', { name: 'Filter by kind' });
    expect([...kind.options].map(o => o.textContent)).toEqual(['Kind: All', 'People', 'Accounts', 'Resources', 'Systems']);
    fireEvent.change(kind, { target: { value: 'Resource' } });
    expect(listed()).toEqual(['Application catalogue', 'Tag catalogue']);
  });

  it('has no kind filter on Organisation or Applications, and a hidden one never narrows', () => {
    const { rerender } = mount();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by kind' }), { target: { value: 'Resource' } });
    expect(listed()).toHaveLength(2);
    for (const tab of ['OrganizationalUnit', 'LogicalApplication']) {
      rerender(h(ContextTreeSelector, { roots, renderTree, onOpenContext: vi.fn(), loading: false, tab }));
      expect(screen.queryByRole('combobox', { name: 'Filter by kind' })).toBeNull();
      expect(listed()).toHaveLength(5);
    }
  });

  it('puts the Show switch in the header with only the kinds offered, and reports a pick', () => {
    const onKindChange = vi.fn();
    mount({ tab: 'OrganizationalUnit', kinds: [{ key: 'Principal', label: 'Accounts' }, { key: 'Resource', label: 'Resources' }], kind: 'Principal', onKindChange });
    const show = screen.getByRole('group', { name: 'Show' });
    expect(within(show).getAllByRole('button').map(b => b.textContent)).toEqual(['Accounts', 'Resources']);
    expect(within(show).getByRole('button', { name: 'Accounts' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(show).getByRole('button', { name: 'Resources' }));
    expect(onKindChange).toHaveBeenCalledWith('Resource');
  });

  it('with one kind, names it instead of offering a switch of one', () => {
    mount({ tab: 'OrganizationalUnit', kinds: [{ key: 'Principal', label: 'Accounts' }], kind: 'Principal' });
    expect(screen.queryByRole('group', { name: 'Show' })).toBeNull();
    expect(screen.getByText('Show:').parentElement).toHaveTextContent('Show:Accounts');
  });

  it('says where units of the kind come from when there are none, and draws no tree', () => {
    mount({ roots: [], tab: 'OrganizationalUnit', kind: 'Identity' });
    expect(screen.getByText(/^No units of people yet\. Units of people come from an HR import or from the manager-hierarchy rule\./)).toBeInTheDocument();
    expect(listed()).toEqual([]);
    expect(screen.queryByRole('combobox', { name: 'Filter by system' })).toBeNull();
  });

  it('tells a filter that matches nothing apart from an empty tab', () => {
    mount();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by system' }), { target: { value: '7' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by source' }), { target: { value: 'manual' } });
    expect(screen.getByText('No units match these filters.')).toBeInTheDocument();
    expect(headings()).toEqual([]);
  });

  it('shows the loading line while roots load', () => {
    mount({ roots: [], loading: true });
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText(/No units/)).toBeNull();
  });

  it('opens the New wizard from "+ New", and has no "+ New" without the callback', () => {
    const onNewTree = vi.fn();
    const { unmount } = mount({ onNewTree });
    fireEvent.click(screen.getByRole('button', { name: '+ New' }));
    expect(onNewTree).toHaveBeenCalled();
    unmount();
    mount();
    expect(screen.queryByRole('button', { name: '+ New' })).toBeNull();
  });

  it('labels the extended search for what it does', () => {
    mount();
    expect(screen.getByRole('checkbox', { name: 'Also search other fields' })).not.toBeChecked();
    expect(screen.getByRole('searchbox', { name: 'Find a unit' })).toBeInTheDocument();
  });
});
