import ContextMemberPicker from './contexts/ContextMemberPicker';

// ─── Relationships tab ─────────────────────────────────────────────────────────
// Sub-contexts list + the paginated, searchable members panel (with analyst
// add/remove for manual + generated contexts).

export default function ContextRelationshipsTab({ subContexts, ...panelProps }) {
  return (
    <>
      {subContexts.length > 0 && <SubContextsList subContexts={subContexts} onOpenDetail={panelProps.onOpenDetail} />}
      <MembersPanel {...panelProps} />
    </>
  );
}

// ─── Sub-contexts card ─────────────────────────────────────────────────────
function SubContextsList({ subContexts, onOpenDetail }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
        Sub-contexts ({subContexts.length})
      </h3>
      <div className="space-y-1">
        {subContexts.map(sc => (
          <button
            key={sc.id}
            onClick={() => onOpenDetail('context', sc.id, sc.displayName)}
            className="w-full text-left flex items-center justify-between px-3 py-2 rounded hover:bg-sky-50 dark:bg-sky-900/30 transition-colors group"
          >
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-sky-100 text-sky-700 dark:text-sky-300 text-[9px] font-bold">CTX</span>
              <span className="text-sm text-gray-900 dark:text-white group-hover:text-sky-700 dark:hover:text-sky-300">{sc.displayName}</span>
            </div>
            {sc.memberCount != null && (
              <span className="text-xs text-gray-600 dark:text-gray-500">{sc.memberCount} members</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Members panel ─────────────────────────────────────────────────────────
function MembersPanel({
  contextId, attrs, canEditMembers, isGenerated,
  includeDescendants, onIncludeDescendantsChange,
  memberSearch, onMemberSearchChange,
  members, memberTotal, membersLoading,
  memberPage, onMemberPageChange, pageSize,
  authFetch, onMembersChanged, onOpenDetail,
}) {
  const totalPages = Math.ceil(memberTotal / pageSize);

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
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
      <div className="flex items-center justify-between mb-3 gap-4 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Members ({memberTotal})
          {attrs.totalMemberCount > (attrs.directMemberCount || 0) && !includeDescendants && (
            <span className="ml-2 text-[11px] font-normal text-gray-500 dark:text-gray-400">
              direct only — {attrs.directMemberCount || 0} of {attrs.totalMemberCount} total
            </span>
          )}
        </h3>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={includeDescendants}
              onChange={e => onIncludeDescendantsChange(e.target.checked)}
              className="w-3.5 h-3.5"
            />
            Include sub-contexts
          </label>
          <input
            type="text"
            value={memberSearch}
            onChange={e => onMemberSearchChange(e.target.value)}
            placeholder="Search members..."
            className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1 w-64 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-sky-400 dark:focus:ring-sky-500 focus:border-transparent"
            aria-label="Search members"
          />
        </div>
      </div>

      {canEditMembers && (
        <div className="mb-4">
          {isGenerated && (
            <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">
              Manually-added members (<code>addedBy=analyst</code>) survive future plugin runs.
              Algorithm-produced members are replaced on every run.
            </p>
          )}
          <ContextMemberPicker
            contextId={contextId}
            targetType={attrs.targetType}
            existingMemberIds={members.map(m => m.id)}
            onAdded={onMembersChanged}
          />
        </div>
      )}

      {membersLoading ? (
        <div className="text-center text-gray-600 dark:text-gray-500 py-8 text-sm">Loading members...</div>
      ) : members.length === 0 ? (
        <div className="text-center text-gray-600 dark:text-gray-500 py-8 text-sm">No members found.</div>
      ) : (
        <>
          <MembersTable
            members={members}
            canEditMembers={canEditMembers}
            isGenerated={isGenerated}
            includeDescendants={includeDescendants}
            targetType={attrs.targetType}
            onOpenDetail={onOpenDetail}
            onRemove={removeMember}
          />

          {totalPages > 1 && (
            <MembersPagination
              memberPage={memberPage}
              totalPages={totalPages}
              onMemberPageChange={onMemberPageChange}
            />
          )}
        </>
      )}
    </div>
  );
}

// ─── Members table ─────────────────────────────────────────────────────────
function MembersTable({ members, canEditMembers, isGenerated, includeDescendants, targetType, onOpenDetail, onRemove }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
            <th className="pb-2 font-medium">Name</th>
            <th className="pb-2 font-medium">Email</th>
            <th className="pb-2 font-medium">Job Title</th>
            <th className="pb-2 font-medium">Type</th>
            <th className="pb-2 font-medium">Status</th>
            {canEditMembers && <th className="pb-2 font-medium"></th>}
          </tr>
        </thead>
        <tbody>
          {members.map(m => (
            <tr
              key={m.id}
              className="border-b border-gray-50 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
              onClick={() => onOpenDetail(memberDetailKind(targetType), m.id, m.displayName)}
            >
              <td className="py-1.5 text-blue-600 dark:text-blue-400 hover:underline">{m.displayName}</td>
              <td className="py-1.5 text-gray-600 dark:text-gray-400">{m.email || '-'}</td>
              <td className="py-1.5 text-gray-600 dark:text-gray-400">{m.jobTitle || '-'}</td>
              <td className="py-1.5">
                {m.principalType && (
                  <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded px-1.5 py-0.5">{m.principalType}</span>
                )}
              </td>
              <td className="py-1.5">
                {m.accountEnabled != null && (
                  <span className={`text-xs rounded px-1.5 py-0.5 ${m.accountEnabled ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700 dark:text-red-400'}`}>
                    {m.accountEnabled ? 'Active' : 'Disabled'}
                  </span>
                )}
              </td>
              {canEditMembers && (
                <td className="py-1.5 text-right">
                  {includeDescendants ? (
                    <span className="text-[11px] text-gray-600 dark:text-gray-500" title="Turn off sub-context view to remove members">—</span>
                  ) : (
                    <RemoveMemberButton
                      memberRow={m}
                      onRemove={onRemove}
                      isGenerated={isGenerated}
                    />
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
  return (
    <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
      <button
        onClick={() => onMemberPageChange(p => Math.max(0, p - 1))}
        disabled={memberPage === 0}
        className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed border border-gray-200 dark:border-gray-700 rounded px-2 py-1"
      >
        Previous
      </button>
      <span className="text-xs text-gray-600 dark:text-gray-500">
        Page {memberPage + 1} of {totalPages}
      </span>
      <button
        onClick={() => onMemberPageChange(p => Math.min(totalPages - 1, p + 1))}
        disabled={memberPage >= totalPages - 1}
        className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed border border-gray-200 dark:border-gray-700 rounded px-2 py-1"
      >
        Next
      </button>
    </div>
  );
}

// Per-row Remove button. On a manual context, every member was added by
// an analyst and remove is final. On a generated context, members have
// addedBy='algorithm' (plugin output) or 'analyst' (manual addition);
// the remove button differentiates so the analyst knows whether the row
// will come back on the next plugin run.
function RemoveMemberButton({ memberRow, onRemove, isGenerated }) {
  const isAlgoRow = memberRow.addedBy === 'algorithm';
  if (isGenerated && isAlgoRow) {
    return (
      <button
        onClick={e => { e.stopPropagation(); onRemove(memberRow.id); }}
        className="text-[11px] text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-300"
        title="Algorithm-produced member — removing now; the next plugin run will re-add it unless you tune plugin parameters."
      >Remove (will return)</button>
    );
  }
  return (
    <button
      onClick={e => { e.stopPropagation(); onRemove(memberRow.id); }}
      className="text-[11px] text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300"
      title="Remove from context"
    >Remove</button>
  );
}
