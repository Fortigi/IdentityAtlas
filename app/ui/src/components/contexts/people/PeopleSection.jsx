import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import ContextMemberPicker from '@ui/components/contexts/ContextMemberPicker';
import { removeContextMember } from '@ui/components/contexts/memberEdits';
import { MembersPagination } from '@ui/components/ContextRelationshipsTab';
import PersonRow from './PersonRow';
import { usePeople } from './usePeople';
import { PEOPLE_FILTERS, countsLine } from './people.helpers';

// ─── People — everyone in a unit, and everyone who was, once each ────────
// One list for the members the source lists and what the added sources say about
// people (GET /api/contexts/:id/people): a row per person, with one status
// (Current · Came back · Not confirmed · Left (decided) · Left), their role here,
// where it comes from, what they still hold, and the claims about them as icons.
// Filters: Current · Former · All, each with its count; "To decide" (the open
// contradictions about people) when there are any. Current first, by name. The
// filter is the page's (`filter`, `onFilterChange`): the attention line under the
// header sets it too. A reader (business view, context owner) sees confirmed
// claims only — and the former people too: who left but can still get in is the
// most useful thing the page tells them.
//
// `canEditMembers` (a context created here, an analyst): "Edit members" adds the
// add box and a Remove on every row the list holds. `version` re-reads the list
// after anything elsewhere on the page changed it. `heading`: an application
// calls its people "People", the same as a unit; its members (resources) are a
// list of their own.

const CARD = 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 scroll-mt-4';
const TAB = 'rounded-full px-3 py-1 text-sm font-medium';
const TAB_ON = 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900';
const TAB_OFF = 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600';

function FilterTabs({ filter, counts, onChange }) {
  return (
    <div role="group" aria-label="Show" className="flex flex-wrap items-center gap-1.5">
      {PEOPLE_FILTERS.map(f => (
        <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => onChange(f.key)}
          className={`${TAB} ${filter === f.key ? TAB_ON : TAB_OFF}`}>
          {f.label} <span className="tabular-nums">{counts[f.key] ?? 0}</span>
        </button>
      ))}
      {counts.decide > 0 && (
        <button type="button" aria-pressed={filter === 'decide'} onClick={() => onChange('decide')}
          className={`${TAB} ${filter === 'decide' ? 'bg-amber-700 text-white dark:bg-amber-300 dark:text-gray-900' : 'bg-amber-50 text-amber-900 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-100'}`}>
          To decide <span className="tabular-nums">{counts.decide}</span>
        </button>
      )}
    </div>
  );
}

function PeopleTable({ people, onRemove, ...rowProps }) {
  return (
    <table className="w-full text-sm">
      <thead className="hidden sm:table-header-group">
        <tr className="text-left text-xs text-gray-600 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
          <th className="pb-2 pr-3 font-medium">Person</th>
          <th className="pb-2 pr-3 font-medium">Status</th>
          <th className="pb-2 pr-3 font-medium">Role</th>
          <th className="pb-2 pr-3 font-medium">Source</th>
          <th className="pb-2 pr-3 text-right font-medium">Access</th>
          <th className="pb-2 pr-3 font-medium"><span className="sr-only">What the sources say</span></th>
          {onRemove && <th className="pb-2 font-medium"><span className="sr-only">Actions</span></th>}
        </tr>
      </thead>
      <tbody>
        {people.map(p => <PersonRow key={p.key} person={p} onRemove={onRemove} {...rowProps} />)}
      </tbody>
    </table>
  );
}

function Body({ list, ...tableProps }) {
  if (list.loading && list.people.length === 0) return <p className="py-6 text-center text-sm text-gray-600 dark:text-gray-400">Loading people…</p>;
  if (list.error) return <p role="alert" className="py-6 text-center text-sm text-red-700 dark:text-red-400">People could not be loaded ({list.error.message}).</p>;
  if (list.people.length === 0) return <p className="py-6 text-center text-sm text-gray-600 dark:text-gray-400">Nobody here.</p>;
  return <PeopleTable people={list.people} {...tableProps} />;
}

export default function PeopleSection({ id, attrs, filter, onFilterChange, version = 0, canEditMembers = false, onOpenDetail, onMembersChanged, hideWhenEmpty = false }) {
  const { authFetch } = useAuth();
  const [editing, setEditing] = useState(false);
  const list = usePeople(authFetch, attrs.id, { filter, version });
  const editMode = canEditMembers && editing;
  // An application's members are resources: its People section shows only when a source named someone.
  if (hideWhenEmpty && !list.loading && list.counts.all === 0 && !list.search) return null;

  async function remove(person) {
    if (await removeContextMember(authFetch, attrs.id, person.principalId || person.identityId)) { list.reload(); onMembersChanged?.(); }
  }
  function added() { list.reload(); onMembersChanged?.(); }

  return (
    <section id={id} aria-label="People" className={CARD}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
          People <span className="ml-1 text-xs font-normal text-gray-600 dark:text-gray-400">{countsLine(list.counts)}</span>
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <input type="search" value={list.search} onChange={e => list.setSearch(e.target.value)} aria-label="Search people" placeholder="Search…"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500 sm:w-56" />
          {canEditMembers && (
            <button type="button" onClick={() => setEditing(e => !e)} aria-pressed={editMode}
              className="rounded bg-gray-200 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600">
              {editMode ? 'Done' : 'Edit members'}
            </button>
          )}
        </div>
      </div>
      <FilterTabs filter={filter} counts={list.counts} onChange={onFilterChange} />
      {editMode && (
        <div className="mt-3">
          <ContextMemberPicker contextId={attrs.id} targetType={attrs.targetType} existingMemberIds={list.people.map(p => p.principalId || p.identityId).filter(Boolean)} onAdded={added} />
        </div>
      )}
      <div className="mt-3">
        <Body list={list} listName={attrs.scopeSystemName} linkedResources={list.linkedResources} contextId={attrs.id} targetType={attrs.targetType} onOpenDetail={onOpenDetail} onRemove={editMode ? remove : undefined} />
      </div>
      {list.pages > 1 && <MembersPagination memberPage={list.page} totalPages={list.pages} onMemberPageChange={list.setPage} />}
    </section>
  );
}
