import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';
import { formatDate } from '../utils/formatters';

function formatNum(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString();
}

// ─── Stat card ─────────────────────────────────────────────
function StatCard({ label, value, sub, color = 'gray', onClick }) {
  const colorMap = {
    gray:   'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700',
    blue:   'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-700',
    green:  'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-700',
    red:    'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-700',
    yellow: 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-700',
    orange: 'bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-700',
  };
  const textMap = {
    gray:   'text-gray-900 dark:text-white',
    blue:   'text-blue-900 dark:text-blue-200',
    green:  'text-green-900 dark:text-green-200',
    red:    'text-red-900 dark:text-red-200',
    yellow: 'text-yellow-900 dark:text-yellow-200',
    orange: 'text-orange-900 dark:text-orange-200',
  };
  const clickable = !!onClick;
  return (
    <div
      className={`rounded-lg border p-4 ${colorMap[color] || colorMap.gray} ${clickable ? 'cursor-pointer hover:ring-2 hover:ring-offset-1 hover:ring-blue-300 transition-shadow' : ''}`}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
    >
      <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${textMap[color] || textMap.gray}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{sub}</div>}
      {clickable && <div className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">Click to view details</div>}
    </div>
  );
}

// ─── Collapsible section ───────────────────────────────────
function CollapsibleSection({ title, count, children, open: controlledOpen, onToggle }) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const handleToggle = onToggle || (() => setInternalOpen(o => !o));
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg mt-6">
      <button
        onClick={handleToggle}
        className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-300 p-5 pb-4 w-full text-left hover:text-gray-900 dark:hover:text-white"
      >
        <span className="text-xs">{isOpen ? '▼' : '▶'}</span>
        {title}
        {count != null && <span className="text-xs font-normal text-gray-400 dark:text-gray-500">({count})</span>}
      </button>
      {isOpen && <div className="px-5 pb-5">{children}</div>}
    </div>
  );
}

// ─── Category badge ────────────────────────────────────────
function CategoryBadge({ name, color }) {
  if (!name) return null;
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium"
      style={{ backgroundColor: color ? `${color}20` : '#f3f4f6', color: color || '#6b7280', border: `1px solid ${color || '#d1d5db'}40` }}
    >
      {color && <span className="w-2 h-2 rounded-full inline-block flex-shrink-0" style={{ backgroundColor: color }} />}
      {name}
    </span>
  );
}

// ─── Compliance status badge ───────────────────────────────
const STATUS_STYLES = {
  Overdue:        'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300',
  'Reviewed Late':'bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-300',
  'In Progress':  'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300',
  Compliant:      'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300',
};

// ═══════════════════════════════════════════════════════════
// Main component
// ═══════════════════════════════════════════════════════════
export default function GovernancePage() {
  const { authFetch } = useAuth();
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [categories, setCategories] = useState(null);

  const [drilldown, setDrilldown] = useState(null);
  const [drilldownOpen, setDrilldownOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      authFetch('/api/governance/summary').then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
      authFetch('/api/governance/categories').then(r => r.ok ? r.json() : []).catch(() => []),
    ])
      .then(([summaryData, cats]) => {
        if (!cancelled) {
          setSummary(summaryData);
          setCategories(cats);
        }
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [authFetch]);

  const loadDrilldown = useCallback((filter, category) => {
    setDrilldown({ filter, category, data: null, loading: true });
    setDrilldownOpen(true);
    let url = `/api/governance/review-compliance?filter=${encodeURIComponent(filter)}`;
    if (category) url += `&category=${encodeURIComponent(category)}`;
    authFetch(url)
      .then(r => r.json())
      .then(data => setDrilldown(prev => ({ ...prev, data, loading: false })))
      .catch(() => setDrilldown(prev => ({ ...prev, data: [], loading: false })));
  }, [authFetch]);

  const handleCategoryChange = useCallback((newCategory) => {
    setSelectedCategory(newCategory);
    if (drilldown?.filter) {
      loadDrilldown(drilldown.filter, newCategory);
    }
  }, [drilldown, loadDrilldown]);

  const handleTileClick = useCallback((filter) => {
    loadDrilldown(filter, selectedCategory);
  }, [loadDrilldown, selectedCategory]);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500 dark:text-gray-400">Loading certification data...</div>;
  }
  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-6">
        <h2 className="text-red-800 dark:text-red-300 font-semibold">Error loading certification data</h2>
        <p className="text-red-600 dark:text-red-400 mt-1 text-sm">{error}</p>
      </div>
    );
  }
  if (!summary) return null;

  const { totalAPs, compliant, overdue, reviewedLate, inProgress } = summary;
  const compliantPct = totalAPs > 0 ? Math.round((compliant / totalAPs) * 1000) / 10 : 0;

  const FILTER_LABELS = {
    overdue: 'Overdue Business Roles',
    'reviewed-late': 'Reviewed Late',
    compliant: 'Compliant Business Roles',
    'in-progress': 'Reviews In Progress',
  };

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Certification Compliance</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Per business role: is the latest periodic review completed on time?
        </p>
      </div>

      {/* ─── Category Filter ───────────────────────────────── */}
      {categories && categories.length > 0 && (
        <div className="mb-4 flex items-center gap-2">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Category:</label>
          <select
            value={selectedCategory}
            onChange={e => handleCategoryChange(e.target.value)}
            className="text-sm border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-300"
          >
            <option value="">All Categories</option>
            {categories.map(cat => (
              <option key={cat.id} value={cat.id}>{cat.name}</option>
            ))}
            <option value="uncategorized">Uncategorized</option>
          </select>
        </div>
      )}

      {/* ─── Stat Cards ───────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
        <StatCard label="Business Roles" value={formatNum(totalAPs)} sub="with periodic reviews" color="gray" />
        <StatCard label="Compliant" value={formatNum(compliant)} sub={`${compliantPct}% on time`} color="green"
          onClick={compliant > 0 ? () => handleTileClick('compliant') : undefined} />
        <StatCard label="Overdue" value={formatNum(overdue)} sub="deadline passed, not reviewed"
          color={overdue > 0 ? 'red' : 'green'} onClick={overdue > 0 ? () => handleTileClick('overdue') : undefined} />
        <StatCard label="Reviewed Late" value={formatNum(reviewedLate)} sub="completed after deadline"
          color={reviewedLate > 0 ? 'orange' : 'green'} onClick={reviewedLate > 0 ? () => handleTileClick('reviewed-late') : undefined} />
        <StatCard label="In Progress" value={formatNum(inProgress)} sub="deadline not yet passed"
          color={inProgress > 0 ? 'blue' : 'green'} onClick={inProgress > 0 ? () => handleTileClick('in-progress') : undefined} />
      </div>

      {/* Compliance bar */}
      {totalAPs > 0 && (
        <div>
          <div className="flex rounded-full h-4 overflow-hidden bg-gray-100 dark:bg-gray-700">
            <div className="bg-green-500" style={{ width: `${(compliant / totalAPs * 100)}%` }} title={`${compliant} compliant`} />
            <div className="bg-red-400" style={{ width: `${(overdue / totalAPs * 100)}%` }} title={`${overdue} overdue`} />
            <div className="bg-orange-400" style={{ width: `${(reviewedLate / totalAPs * 100)}%` }} title={`${reviewedLate} reviewed late`} />
            <div className="bg-blue-400" style={{ width: `${(inProgress / totalAPs * 100)}%` }} title={`${inProgress} in progress`} />
          </div>
          <div className="flex gap-4 text-xs text-gray-500 dark:text-gray-400 mt-1">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 inline-block" />Compliant</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400 inline-block" />Overdue</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-400 inline-block" />Reviewed Late</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-400 inline-block" />In Progress</span>
          </div>
        </div>
      )}

      {/* ─── Drill-down ────────────────────────────────────── */}
      {drilldown && (
        <CollapsibleSection
          title={FILTER_LABELS[drilldown.filter] || 'Business Roles'}
          count={drilldown.data?.length}
          open={drilldownOpen}
          onToggle={() => setDrilldownOpen(o => !o)}
        >
          <DrilldownTable data={drilldown} />
        </CollapsibleSection>
      )}
    </div>
  );
}

// ─── Drill-down table ────────────────────────────────────────

function DrilldownTable({ data: drilldown }) {
  if (drilldown.loading) return <div className="text-sm text-gray-400 dark:text-gray-500 animate-pulse">Loading...</div>;
  if (!drilldown.data || drilldown.data.length === 0) return <p className="text-sm text-gray-400 dark:text-gray-500 italic">No business roles found</p>;

  const rows = drilldown.data;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-700 border-b border-gray-200 dark:border-gray-600">
            <th className="px-3 py-2 font-medium">Business Role</th>
            <th className="px-3 py-2 font-medium">Category</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Review Deadline</th>
            <th className="px-3 py-2 font-medium text-right">Days Overdue</th>
            <th className="px-3 py-2 font-medium text-right">Decisions</th>
            <th className="px-3 py-2 font-medium text-right">Not Reviewed</th>
            <th className="px-3 py-2 font-medium">Last Reviewed By</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.accessPackageId} className={`border-b border-gray-50 dark:border-gray-700 ${
              r.complianceStatus === 'Overdue' ? 'hover:bg-red-50 dark:hover:bg-red-900/20' :
              r.complianceStatus === 'Reviewed Late' ? 'hover:bg-orange-50 dark:hover:bg-orange-900/20' :
              'hover:bg-gray-50 dark:hover:bg-gray-700/50'
            }`}>
              <td className="px-3 py-2">
                <div className="text-gray-900 dark:text-white font-medium">{r.accessPackageName}</div>
                {r.catalogName && <div className="text-xs text-gray-400 dark:text-gray-500">{r.catalogName}</div>}
              </td>
              <td className="px-3 py-2">
                {r.categoryName
                  ? <CategoryBadge name={r.categoryName} color={r.categoryColor} />
                  : <span className="text-gray-400 dark:text-gray-500 text-xs">{'—'}</span>
                }
              </td>
              <td className="px-3 py-2">
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[r.complianceStatus] || 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'}`}>
                  {r.complianceStatus}
                </span>
              </td>
              <td className="px-3 py-2 text-gray-500 dark:text-gray-400 text-xs whitespace-nowrap">{formatDate(r.deadline)}</td>
              <td className="px-3 py-2 text-right">
                {r.daysOverdue > 0 ? (
                  <span className="text-red-600 dark:text-red-400 font-semibold">{r.daysOverdue}d</span>
                ) : (
                  <span className="text-gray-400 dark:text-gray-500">{'—'}</span>
                )}
              </td>
              <td className="px-3 py-2 text-right text-gray-700 dark:text-gray-300">{r.totalDecisions}</td>
              <td className="px-3 py-2 text-right">
                {r.notReviewed > 0
                  ? <span className="text-red-600 dark:text-red-400 font-medium">{r.notReviewed}</span>
                  : <span className="text-gray-400 dark:text-gray-500">0</span>
                }
              </td>
              <td className="px-3 py-2 text-gray-600 dark:text-gray-400 text-xs">{r.lastReviewedBy || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
