import { TierBadge } from './DepartmentBadges';
import { TIER_ORDER, TIER_DISPLAY, TIER_BAR_COLORS } from './departmentTiers';

function buildSummaryText(directMembers, allMembers, directRisk, allRisk, node) {
  const parts = [];
  const direct = directMembers.length;
  const total = allMembers.length;
  const scored = allMembers.filter(m => m.riskScore != null);

  if (scored.length === 0) return 'No risk score data available for this department.';

  const tierParts = TIER_DISPLAY
    .filter(t => allRisk.tierCounts[t] > 0)
    .map(t => `${allRisk.tierCounts[t]} ${t.toLowerCase()}`);
  if (tierParts.length > 0) {
    const pct = Math.round((scored.length / total) * 100);
    parts.push(`Of ${total} total member${total !== 1 ? 's' : ''} (${direct} direct${total > direct ? `, ${total - direct} indirect` : ''}), ${pct === 100 ? 'all have' : `${scored.length} have`} risk scores: ${tierParts.join(', ')}.`);
  }

  const highTiers = TIER_DISPLAY.filter(t => (TIER_ORDER[t] || 0) >= 3 && allRisk.tierCounts[t] > 0);
  if (highTiers.length > 0) {
    const highCount = highTiers.reduce((sum, t) => sum + (allRisk.tierCounts[t] || 0), 0);
    const highPct = Math.round((highCount / scored.length) * 100);
    parts.push(`${highCount} member${highCount !== 1 ? 's' : ''} (${highPct}%) are rated medium or above, which drives the department's overall ${allRisk.maxTier.toLowerCase()} risk classification.`);
  } else {
    parts.push(`No members are rated medium risk or above. The department's risk posture is ${allRisk.maxTier.toLowerCase()}.`);
  }

  const scores = scored.map(m => m.riskScore);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (min !== max) {
    parts.push(`Scores range from ${min} to ${max} (avg ${allRisk.avgScore}).`);
  }

  return parts.join(' ');
}

export default function RiskSummary({ directMembers, allMembers, directRisk, allRisk, subDepts, node, onOpenDetail }) {
  const scored = allMembers.filter(m => m.riskScore != null);
  if (scored.length === 0) return null;

  const scores = scored.map(m => m.riskScore).sort((a, b) => a - b);
  const min = scores[0];
  const max = scores[scores.length - 1];
  const median = scores.length % 2 === 0
    ? Math.round((scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2)
    : scores[Math.floor(scores.length / 2)];

  const topRisk = [...scored].sort((a, b) => b.riskScore - a.riskScore).slice(0, 5);

  const allTiers = [...TIER_DISPLAY, 'None'];
  const tierSegments = allTiers
    .map(t => ({ tier: t, count: allRisk.tierCounts[t] || 0 }))
    .filter(s => s.count > 0);
  const totalScored = scored.length;

  const summaryText = buildSummaryText(directMembers, allMembers, directRisk, allRisk, node);

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm overflow-hidden">
      <div className="px-6 py-3 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/50">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Risk Summary</h3>
      </div>

      <div className="px-6 py-4 space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{summaryText}</p>

        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">Risk distribution</div>
          <div className="flex h-6 rounded-md overflow-hidden border border-gray-200 dark:border-gray-600">
            {tierSegments.map(s => {
              const pct = (s.count / totalScored) * 100;
              return (
                <div
                  key={s.tier}
                  className="flex items-center justify-center text-[10px] font-medium text-white transition-all"
                  style={{ width: `${pct}%`, backgroundColor: TIER_BAR_COLORS[s.tier], minWidth: pct > 0 ? '18px' : 0 }}
                  title={`${s.tier}: ${s.count} (${Math.round(pct)}%)`}
                >
                  {pct >= 10 ? s.count : ''}
                </div>
              );
            })}
          </div>
          <div className="flex gap-3 mt-1.5">
            {tierSegments.map(s => (
              <div key={s.tier} className="flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400">
                <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: TIER_BAR_COLORS[s.tier] }} />
                {s.tier} ({s.count})
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">Score statistics</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {[
                { label: 'Average', value: allRisk.avgScore },
                { label: 'Median', value: median },
                { label: 'Lowest', value: min },
                { label: 'Highest', value: max },
                { label: 'Scored', value: `${scored.length} / ${allMembers.length}` },
              ].map(s => (
                <div key={s.label} className="flex justify-between text-xs py-0.5">
                  <span className="text-gray-600 dark:text-gray-500">{s.label}</span>
                  <span className="font-mono text-gray-700 dark:text-gray-300">{s.value}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">Highest risk members</div>
            <div className="space-y-1">
              {topRisk.map(user => (
                <div key={user.id} className="flex items-center gap-2 text-xs">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: TIER_BAR_COLORS[user.riskTier || 'None'] }} />
                  <button
                    onClick={() => onOpenDetail('user', user.id, user.displayName)}
                    className="text-blue-700 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300 hover:underline truncate"
                  >
                    {user.displayName}
                  </button>
                  <span className="ml-auto font-mono text-gray-600 dark:text-gray-500 shrink-0">{user.riskScore}</span>
                  <TierBadge tier={user.riskTier} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
