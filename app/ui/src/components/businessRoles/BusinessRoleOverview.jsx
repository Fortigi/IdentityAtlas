import BusinessRoleOwners from './BusinessRoleOwners';

// ─── Overview of a business role ─────────────────────────────────────────
// The essentials: how big it is and who answers for it. How people get, keep
// and lose the role is on the Lifecycle tab.

function Stat({ label, value, onClick }) {
  return (
    <button type="button" onClick={onClick} className="rounded border border-gray-200 bg-white px-3 py-2 text-left hover:border-blue-400 hover:bg-blue-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:border-blue-500 dark:hover:bg-blue-900/20">
      <span className="block text-lg font-semibold text-gray-900 dark:text-gray-100">{value}</span>
      <span className="block text-xs text-gray-600 dark:text-gray-400">{label}</span>
    </button>
  );
}

export default function BusinessRoleOverview({ roleId, data, onOpenDetail, onOpenTab }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="People" value={data.assignmentCount ?? 0} onClick={() => onOpenTab('members')} />
        <Stat label="Resources" value={data.groupCount ?? 0} onClick={() => onOpenTab('resources')} />
      </div>
      <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">Who answers for this role</h3>
        <BusinessRoleOwners roleId={roleId} onOpenDetail={onOpenDetail} />
      </section>
    </div>
  );
}
