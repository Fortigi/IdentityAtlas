// Identity Atlas — dashboard feature-status row.
//
// The three "how are the higher-level features doing" cards (Risk Scoring,
// Certifications, Crawlers) shown below the main grid once data is loaded.
// Extracted from DashboardPage so the per-feature status/detail branches don't
// inflate that component. Risk Scoring — the only card with a three-way
// status — gets its own small component to keep each unit trivial.

import { formatCompactNumber as formatNumber } from '@ui/utils/formatters';

export default function FeatureStatusRow({ stats, onNavigate }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
      <RiskScoringCard stats={stats} onNavigate={onNavigate} />
      <FeatureCard
        label="Certifications"
        status={stats.certifications > 0 ? `${formatNumber(stats.certifications)} decisions` : 'None'}
        detail={stats.certifications > 0 ? 'Access reviews imported' : 'No access review data'}
        ok={stats.certifications > 0}
      />
      <FeatureCard
        label="Crawlers"
        status={stats.enabledCrawlers > 0 ? `${stats.enabledCrawlers} configured` : 'None'}
        detail={stats.runningJobs > 0 ? `${stats.runningJobs} job(s) running now` : 'Configure in Admin → Crawlers'}
        ok={stats.enabledCrawlers > 0}
        onClick={() => onNavigate?.('admin')}
      />
    </div>
  );
}

function RiskScoringCard({ stats, onNavigate }) {
  const status = stats.activeClassifiers > 0 ? 'Active' : stats.llmConfigured ? 'Ready' : 'Not configured';
  const detail = stats.riskScores > 0
    ? `${formatNumber(stats.riskScores)} entities scored`
    : stats.llmConfigured ? 'LLM configured, no profile yet' : 'Configure in Admin → LLM Settings';
  return (
    <FeatureCard
      label="Risk Scoring"
      status={status}
      detail={detail}
      ok={stats.activeClassifiers > 0}
      warn={stats.llmConfigured && stats.activeClassifiers === 0}
      onClick={() => onNavigate?.('admin?sub=risk-scoring')}
    />
  );
}

// ─── FeatureCard ──────────────────────────────────────────────────────
function FeatureCard({ label, status, detail, ok, warn, onClick }) {
  const clickable = typeof onClick === 'function';
  const color = ok ? 'text-lime-700'
              : warn ? 'text-amber-700 dark:text-amber-400'
              : 'text-gray-500 dark:text-gray-400';
  const dot = ok ? 'bg-lime-500 shadow-[0_0_8px_rgba(132,204,22,0.6)]'
            : warn ? 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]'
            : 'bg-gray-300 dark:bg-gray-600';
  return (
    <div
      onClick={clickable ? onClick : undefined}
      className={`bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm ring-1 transition-all ${
        ok ? 'ring-lime-200 dark:ring-lime-700/50' : 'ring-gray-200 dark:ring-gray-700'
      } ${clickable ? 'cursor-pointer hover:ring-lime-400 hover:shadow-md hover:-translate-y-0.5' : ''}`}
    >
      <div className="flex items-start gap-3">
        <span className={`inline-block w-2.5 h-2.5 rounded-full mt-1.5 ${dot}`} />
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-widest text-gray-500 dark:text-gray-400 font-semibold">{label}</div>
          <div className={`text-base font-bold mt-1 ${color}`}>{status}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 truncate">{detail}</div>
        </div>
      </div>
    </div>
  );
}
