import { useState, useMemo } from 'react';
import { TIER_STYLES } from '@ui/utils/tierStyles';
import { TierBadge, Avatar } from './DepartmentBadges';
import { TIER_DISPLAY } from './departmentTiers';

// Tabbed member list (Direct / Indirect / All) with a per-tab risk summary bar.
export default function MembersSection({
  directMembers, indirectMembers, allMembers, directRisk, indirectRisk, allRisk, onOpenDetail,
}) {
  const [tab, setTab] = useState('direct');

  const membersByTab = { direct: directMembers, indirect: indirectMembers, all: allMembers };
  const riskByTab = { direct: directRisk, indirect: indirectRisk, all: allRisk };
  const displayMembers = membersByTab[tab];
  const displayRisk = riskByTab[tab];

  const sortedMembers = useMemo(() => {
    return [...displayMembers].sort((a, b) => {
      const riskDiff = (b.riskScore || 0) - (a.riskScore || 0);
      if (riskDiff !== 0) return riskDiff;
      return (a.displayName || '').localeCompare(b.displayName || '');
    });
  }, [displayMembers]);

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm overflow-hidden">
      <div className="flex border-b border-gray-200 dark:border-gray-700 px-6 bg-gray-50 dark:bg-gray-700/50">
        {[
          { key: 'direct', label: 'Direct Members', count: directMembers.length },
          ...(indirectMembers.length > 0
            ? [{ key: 'indirect', label: 'Indirect Members', count: indirectMembers.length }]
            : []),
          ...(indirectMembers.length > 0
            ? [{ key: 'all', label: 'All Members', count: allMembers.length }]
            : []),
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key
                ? 'border-blue-500 text-blue-700 dark:text-blue-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            {t.label} ({t.count})
          </button>
        ))}
      </div>

      {TIER_DISPLAY.some(t => displayRisk.tierCounts[t] > 0) && (
        <div className="flex gap-2 px-6 py-2 border-b border-gray-100 dark:border-gray-700">
          <span className="text-xs text-gray-600 dark:text-gray-500 mr-1 self-center">Avg. score: {displayRisk.avgScore}</span>
          <span className="text-gray-500 dark:text-gray-500 self-center">|</span>
          {TIER_DISPLAY.filter(t => displayRisk.tierCounts[t] > 0).map(t => {
            const s = TIER_STYLES[t];
            return (
              <span key={t} className={`${s.bg} ${s.text} ${s.darkBg} ${s.darkText} text-[11px] px-2 py-0.5 rounded-full border ${s.border} ${s.darkBorder}`}>
                {displayRisk.tierCounts[t]} {t}
              </span>
            );
          })}
        </div>
      )}

      <div className="divide-y divide-gray-50 dark:divide-gray-700">
        {sortedMembers.map(user => (
          <div key={`${user.id}-${user._dept || ''}`} className="flex items-center gap-3 px-6 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700/50">
            <Avatar name={user.displayName} tier={user.riskTier} />
            <div className="min-w-0 flex-1">
              <button
                onClick={() => onOpenDetail('user', user.id, user.displayName)}
                className="text-sm text-blue-700 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300 hover:underline truncate text-left block font-medium"
              >
                {user.displayName}
              </button>
              <div className="text-xs text-gray-600 dark:text-gray-500 truncate">
                {user.jobTitle || '—'}
                {tab !== 'direct' && user._dept && (
                  <span className="ml-1.5 text-gray-500 dark:text-gray-600">({user._dept})</span>
                )}
              </div>
            </div>
            <TierBadge tier={user.riskTier} />
            {user.riskScore != null && (
              <span className="text-xs font-mono text-gray-600 dark:text-gray-500 w-8 text-right shrink-0">{user.riskScore}</span>
            )}
          </div>
        ))}
        {sortedMembers.length === 0 && (
          <div className="px-6 py-8 text-center text-sm text-gray-600 dark:text-gray-500">No members found.</div>
        )}
      </div>
    </div>
  );
}
