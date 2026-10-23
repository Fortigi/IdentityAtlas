import { useState } from 'react';
import ContextMemberPicker from './contexts/ContextMemberPicker';
import ContextTemplateIcon from './contexts/ContextTemplateIcon';
import { memberKindNoun } from '@ui/utils/contextStyles';
import { visibleMemberColumns, memberRowAction } from './ContextRelationshipsTab.helpers';
import { InterviewLeftFlag } from './contexts/interviews/MemberInterviewFacts';
import PreviousMembers from './contexts/interviews/PreviousMembers';

// ─── Sub-units and members ─────────────────────────────────────────────────
// Two plain sections: the sub-units (each opening its own page) and the
// paginated, searchable members. Reading by default; `canEditMembers` (the
// reader can edit contexts, and the context was created here — the only kind
// whose member edits last) adds an "Edit members" button, and only in that mode
// the add box and the per-row Remove appear. On a unit or an application (inside
// a ClaimsProvider) a member an interview says left is flagged on its row, and
// the people the interviews say left come below, under Previous members.

export default function ContextRelationshipsTab({ subContexts, sectionIds = {}, ...panelProps }) {
  return (
    <>
      {subContexts.length > 0 && (
        <SubUnitsList id={sectionIds.subUnits} subContexts={subContexts} attrs={panelProps.attrs} onOpenDetail={panelProps.onOpenDetail} />
      )}
      <MembersPanel id={sectionIds.members} {...panelProps} />
      <PreviousMembers contextId={panelProps.contextId} onOpenDetail={panelProps.onOpenDetail} />
    </>
  );
}

const CARD = 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 scroll-mt-4';

// ─── Sub-units ─────────────────────────────────────────────────────────────
function SubUnitsList({ id, subContexts, attrs, onOpenDetail }) {
  return (
    <section id={id} aria-label="Sub-units" className={CARD}>
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Sub-units ({subContexts.length})</h3>
      <div className="space-y-1">
        {subContexts.map(sc => {
          const body = (
            <>
              <span className="flex items-center gap-2 min-w-0">
                <span className="text-gray-500 dark:text-gray-400"><ContextTemplateIcon category={sc.contextCategory || attrs.contextCategory} /></span>
                <span className="text-sm text-gray-900 dark:text-white group-hover:text-blue-700 dark:group-hover:text-blue-300 truncate">{sc.displayName}</span>
              </span>
              {sc.memberCount != null && (
                <span className="text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">{sc.memberCount} {memberKindNoun(attrs.targetType, sc.memberCount)}</span>
              )}
            </>
          );
          // Without a detail handler (a read-only shell) a sub-unit is a fact, not a link.
          if (!onOpenDetail) {
            return <div key={sc.id} className="flex items-center justify-between gap-3 px-3 py-2">{body}</div>;
          }
          return (
            <button
              key={sc.id}
              type="button"
              onClick={() => onOpenDetail('context', sc.id, sc.displayName)}
              className="w-full text-left flex items-center justify-between gap-3 px-3 py-2 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors group"
            >
              {body}
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ─── Members ───────────────────────────────────────────────────────────────
function MembersPanel({
  id, contextId, attrs, canEditMembers,
  includeDescendants, onIncludeDescendantsChange,
  memberSearch, onMemberSearchChange,
  members, memberTotal, membersLoading, membersError,
  memberPage, onMemberPageChange, pageSize,
  authFetch, onMembersChanged, onOpenDetail,
}) {
  const [editing, setEditing] = useState(false);
  const totalPages = Math.ceil(memberTotal / pageSize);
  const editMode = canEditMembers && editing;
  const hasSubUnitMembers = attrs.totalMemberCount > (attrs.directMemberCount || 0);

  async function removeMember(memberId) {
    try {
      const r = await authFetch(`/api/contexts/${contextId}/members/${memberId}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 204) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      onMembersChanged();
    } catch (err) {
      console.error('Remove member failed:', err);
    }
  }

  return (
    <section id={id} aria-label="Members" className={CARD}>
      <div className="flex items-center justify-between mb-3 gap-4 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Members ({memberTotal})
          {hasSubUnitMembers && !includeDescendants && (
            <span className="ml-2 text-xs font-normal text-gray-600 dark:text-gray-400">in this unit only</span>
          )}
        </h3>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
            <input type="checkbox" checked={includeDescendants} onChange={e => onIncludeDescendantsChange(e.target.checked)} className="w-3.5 h-3.5" />
            Include sub-units
          </label>
          <input
            type="text"
            value={memberSearch}
            onChange={e => onMemberSearchChange(e.target.value)}
            placeholder="Search members…"
            className="text-sm border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1 w-full sm:w-64 bg-white dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-400 dark:focus:ring-blue-500 focus:border-transparent"
            aria-label="Search members"
          />
          {canEditMembers && (
            <button type="button" onClick={() => setEditing(e => !e)} aria-pressed={editMode}
              className="rounded bg-gray-200 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600">
              {editMode ? 'Done' : 'Edit members'}
            </button>
          )}
        </div>
      </div>

      {editMode && <MemberEditBox contextId={contextId} attrs={attrs} members={members} onAdded={onMembersChanged} />}

      <MembersBody
        loading={membersLoading} error={membersError} members={members} attrs={attrs} editMode={editMode}
        includeDescendants={includeDescendants} onOpenDetail={onOpenDetail} onRemove={removeMember}
      />
      {!membersLoading && members.length > 0 && totalPages > 1 && (
        <MembersPagination memberPage={memberPage} totalPages={totalPages} onMemberPageChange={onMemberPageChange} />
      )}
    </section>
  );
}

// Edit mode: the box to add a member.
function MemberEditBox({ contextId, attrs, members, onAdded }) {
  return (
    <div className="mb-4">
      <ContextMemberPicker contextId={contextId} targetType={attrs.targetType} existingMemberIds={members.map(m => m.id)} onAdded={onAdded} />
    </div>
  );
}

function MembersBody({ loading, error, members, ...tableProps }) {
  if (loading) return <div className="text-center text-gray-600 dark:text-gray-400 py-8 text-sm">Loading members…</div>;
  if (error) return <div role="alert" className="text-center text-red-700 dark:text-red-400 py-8 text-sm">Members could not be loaded ({error}).</div>;
  if (members.length === 0) return <div className="text-center text-gray-600 dark:text-gray-400 py-8 text-sm">No members found.</div>;
  return <MembersTable members={members} {...tableProps} />;
}

// The table reads as a two-line card per member on a narrow screen: the name
// on the first line, the other columns wrapping under it.
function MembersTable({ members, attrs, editMode, includeDescendants, onOpenDetail, onRemove }) {
  const columns = visibleMemberColumns(attrs.targetType, members);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="hidden sm:table-header-group">
          <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
            <th className="pb-2 font-medium">Name</th>
            {columns.map(c => <th key={c.label} className={`pb-2 font-medium${c.align === 'right' ? ' text-right' : ''}`}>{c.label}</th>)}
            {editMode && <th className="pb-2 font-medium"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {members.map(m => (
            <tr
              key={m.id}
              className={`flex flex-wrap items-baseline gap-x-3 py-1.5 sm:table-row sm:py-0 border-b border-gray-100 dark:border-gray-700${onOpenDetail ? ' hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer' : ''}`}
              onClick={onOpenDetail ? () => onOpenDetail(memberDetailKind(attrs.targetType), m.id, m.displayName) : undefined}
            >
              <td className={`w-full sm:w-auto sm:py-1.5 ${onOpenDetail ? 'text-blue-700 dark:text-blue-300 hover:underline' : 'text-gray-900 dark:text-gray-100'}`}>
                {m.displayName}<InterviewLeftFlag left={m.interview?.left} />
              </td>
              {columns.map(c => <td key={c.label} className={`sm:py-1.5${c.align === 'right' ? ' sm:text-right' : ''}`}>{c.render(m, { onOpenDetail })}</td>)}
              {editMode && (
                <td className="sm:py-1.5 sm:text-right">
                  <RowAction action={memberRowAction(includeDescendants)} onRemove={() => onRemove(m.id)} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowAction({ action, onRemove }) {
  if (action.kind === 'remove') {
    return (
      <button type="button" onClick={e => { e.stopPropagation(); onRemove(); }}
        className="text-xs text-red-700 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300">Remove</button>
    );
  }
  return <span className="text-xs text-gray-600 dark:text-gray-400" title={action.title}>{action.text}</span>;
}

// Resolve the detail-page kind to open for a member of a context targeting
// the given type.
function memberDetailKind(targetType) {
  if (targetType === 'Identity') return 'identity';
  if (targetType === 'Resource') return 'group';
  if (targetType === 'System') return 'system';
  return 'user';
}

// ─── Pagination ────────────────────────────────────────────────────────────
function MembersPagination({ memberPage, totalPages, onMemberPageChange }) {
  const btn = 'text-xs text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed border border-gray-200 dark:border-gray-700 rounded px-2 py-1';
  return (
    <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
      <button type="button" onClick={() => onMemberPageChange(p => Math.max(0, p - 1))} disabled={memberPage === 0} className={btn}>Previous</button>
      <span className="text-xs text-gray-600 dark:text-gray-400">Page {memberPage + 1} of {totalPages}</span>
      <button type="button" onClick={() => onMemberPageChange(p => Math.min(totalPages - 1, p + 1))} disabled={memberPage >= totalPages - 1} className={btn}>Next</button>
    </div>
  );
}
