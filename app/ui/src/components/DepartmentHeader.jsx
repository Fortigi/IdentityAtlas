import { TIER_STYLES } from '@ui/utils/tierStyles';
import { TierBadge } from './DepartmentBadges';
import { TIER_DISPLAY } from './departmentTiers';

// Department card header: title + member counts, overall-risk tier bar, and the
// sub-departments chip list.
export default function DepartmentHeader({ node, directMembers, directRisk, allRisk, subDepts, onClose }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/50">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 flex items-center justify-center text-lg font-bold">D</div>
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{node.department}</h2>
                <div className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                  {node.directCount || directMembers.length} direct member{(node.directCount || directMembers.length) !== 1 ? 's' : ''}
                  {(node.indirectCount || 0) > 0 && (
                    <span> | {node.indirectCount} indirect</span>
                  )}
                  {node.children.length > 0 && (
                    <span> | {node.children.length} sub-department{node.children.length !== 1 ? 's' : ''}</span>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <TierBadge tier={directRisk.maxTier} showAll />
            <button
              onClick={onClose}
              className="text-gray-600 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
              title="Close"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {TIER_DISPLAY.some(t => allRisk.tierCounts[t] > 0) && (
        <div className="flex gap-2 px-6 py-3 border-b border-gray-100 dark:border-gray-700">
          <span className="text-xs text-gray-500 dark:text-gray-400 mr-1 self-center">Overall risk:</span>
          {TIER_DISPLAY.filter(t => allRisk.tierCounts[t] > 0).map(t => {
            const s = TIER_STYLES[t];
            return (
              <span key={t} className={`${s.bg} ${s.text} ${s.darkBg} ${s.darkText} text-xs px-2.5 py-0.5 rounded-full border ${s.border} ${s.darkBorder}`}>
                {allRisk.tierCounts[t]} {t}
              </span>
            );
          })}
        </div>
      )}

      {subDepts.length > 0 && (
        <div className="px-6 py-3 border-b border-gray-100 dark:border-gray-700">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Sub-departments</div>
          <div className="flex flex-wrap gap-1.5">
            {subDepts.map((d, i) => (
              <span key={i} className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-0.5 rounded-full">
                {d.depth > 0 && <span className="text-gray-500 dark:text-gray-500">{'  '.repeat(d.depth)}</span>}
                {d.name} <span className="text-gray-600 dark:text-gray-500">({d.directCount})</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
