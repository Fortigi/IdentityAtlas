import { useMemo, useState } from 'react';
import { useDebouncedValue } from '@ui/hooks/useDebouncedValue';
import usePersistedState from '@ui/hooks/usePersistedState';
import ExtendedSearchToggle from '@ui/components/ExtendedSearchToggle';
import { SegmentedControl } from '@ui/components/matrix/wizardControls';
import ContextSearchResults from './ContextSearchResults';
import { filterRoots, scopeSystems } from './ContextTreeSelector.helpers';
import {
  groupBySource, hasKindFilter, emptyTreesCopy, SOURCE_OPTIONS, KIND_FILTER_OPTIONS, CONTEXT_EXTENDED_SEARCH_LABEL,
} from './treePanel.helpers';

// Left pane of the Contexts tab: the tab's name, the "Show" switch between the
// kinds of member (Organisation only), "+ New", a search over every level and
// the source / system filters — around the tree itself. The roots that pass the
// filters are listed under a heading per source ("Imported · Fortigi Demo HR",
// "Derived · Department from Principal", "Created here"); the tree is
// the page's: `renderTree(groupRoots, group)` draws each group's roots.

const SELECT_CLASS = 'flex-1 min-w-0 border rounded px-1 py-0.5 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200';

function KindSwitch({ kinds, kind, onKindChange }) {
  if (!kinds?.length) return null;
  return (
    <div className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
      <span aria-hidden={kinds.length > 1 ? 'true' : undefined}>Show:</span>
      {kinds.length > 1
        ? <SegmentedControl label="Show" options={kinds} value={kind} onChange={onKindChange} />
        : <span className="font-medium text-gray-800 dark:text-gray-200">{kinds[0].label}</span>}
    </div>
  );
}

function PanelHeader({ title, kinds, kind, onKindChange, onNewTree }) {
  return (
    <div className="p-3 border-b border-gray-200 dark:border-gray-700 flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="text-sm font-semibold text-gray-800 dark:text-gray-200">{title}</div>
      <KindSwitch kinds={kinds} kind={kind} onKindChange={onKindChange} />
      {onNewTree && (
        <button
          onClick={onNewTree}
          className="ml-auto px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-300"
        >+ New</button>
      )}
    </div>
  );
}

function PanelFilters({ tab, search, setSearch, extendedSearch, setExtendedSearch, filters, setFilter, systems }) {
  return (
    <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 space-y-2 text-xs">
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          aria-label="Find a unit"
          placeholder="Find a unit…"
          className="flex-1 min-w-0 border rounded px-1.5 py-0.5 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200 dark:placeholder-gray-500"
        />
        <ExtendedSearchToggle checked={extendedSearch} onChange={setExtendedSearch} label={CONTEXT_EXTENDED_SEARCH_LABEL} className="flex-shrink-0" />
      </div>
      <div className="flex gap-2">
        {hasKindFilter(tab) && (
          <select aria-label="Filter by kind" value={filters.target} onChange={e => setFilter('target', e.target.value)} className={SELECT_CLASS}>
            <option value="">Kind: All</option>
            {KIND_FILTER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
        <select aria-label="Filter by source" value={filters.variant} onChange={e => setFilter('variant', e.target.value)} className={SELECT_CLASS}>
          <option value="">Source: All</option>
          {SOURCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {systems.length > 0 && (
          <select aria-label="Filter by system" value={filters.system} onChange={e => setFilter('system', e.target.value)} className={SELECT_CLASS}>
            <option value="">System: All</option>
            {systems.map(([id, name]) => <option key={id} value={String(id)}>{name}</option>)}
          </select>
        )}
      </div>
    </div>
  );
}

function SourceGroup({ group, renderTree }) {
  const name = group.detail ? `${group.title} · ${group.detail}` : group.title;
  return (
    <section aria-label={name} className="pt-2">
      <h3 className="px-3 text-xs text-gray-600 dark:text-gray-400">
        <span className="font-semibold uppercase tracking-wide">{group.title}</span>
        {group.detail && <span> · {group.detail}</span>}
      </h3>
      {renderTree?.(group.roots, group)}
    </section>
  );
}

function PanelBody({ loading, roots, filtered, tab, kind, notice, renderTree }) {
  if (loading) return <div className="p-3 text-xs text-gray-500 dark:text-gray-400">Loading…</div>;
  if (filtered.length === 0) {
    return (
      <div className="p-3 text-xs text-gray-600 dark:text-gray-400">
        {roots.length === 0 ? emptyTreesCopy(tab, kind) : 'No units match these filters.'}
      </div>
    );
  }
  return (
    <>
      {notice}
      {groupBySource(filtered).map(g => <SourceGroup key={g.key} group={g} renderTree={renderTree} />)}
    </>
  );
}

export default function ContextTreeSelector({
  title = 'Trees', tab, kinds, kind, onKindChange, roots, renderTree, notice, onNewTree, onOpenContext, loading,
}) {
  const [filters, setFilters] = useState({ target: '', variant: '', system: '' });
  const setFilter = (key, value) => setFilters(f => ({ ...f, [key]: value }));
  // Typing a search swaps the tree for matches from every level.
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 400);
  const [extendedSearch, setExtendedSearch] = usePersistedState('iatlas.list.context.extendedSearch', false);
  const searching = debouncedSearch.trim() !== '';

  const systems = useMemo(() => scopeSystems(roots), [roots]);
  // The kind filter exists on the mixed tabs only; elsewhere it never narrows.
  const target = hasKindFilter(tab) ? filters.target : '';
  const filtered = useMemo(
    () => filterRoots(roots, { target, variant: filters.variant, system: filters.system }),
    [roots, target, filters.variant, filters.system],
  );

  return (
    <div data-testid="context-tree-pane" className="flex flex-col h-full bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700">
      <PanelHeader title={title} kinds={kinds} kind={kind} onKindChange={onKindChange} onNewTree={onNewTree} />
      <PanelFilters
        tab={tab} search={search} setSearch={setSearch} extendedSearch={extendedSearch} setExtendedSearch={setExtendedSearch}
        filters={filters} setFilter={setFilter} systems={systems}
      />
      <div className="flex-1 overflow-auto">
        {searching
          ? <ContextSearchResults term={debouncedSearch} extended={extendedSearch} onOpenContext={onOpenContext} />
          : <PanelBody loading={loading} roots={roots || []} filtered={filtered} tab={tab} kind={kind} notice={notice} renderTree={renderTree} />}
      </div>
    </div>
  );
}
