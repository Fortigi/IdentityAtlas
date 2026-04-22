// Identity Atlas — Dashboard / landing page.
//
// One-shot overview showing:
//   - A brain-like SVG force-graph that echoes the logo
//   - Counts for every entity type (users, resources, identities, ...)
//   - Risk-scoring status (enabled / configured / active profile)
//   - Last sync timestamp
//   - Links to docs, GitHub, license, support
//   - Version number linked to CHANGES.md on GitHub
//
// When no data has been loaded yet, the central call-to-action becomes
// "Configure a crawler" pointing at Admin → Crawlers.

import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../auth/AuthGate';
import { useIsDark } from '../contexts/ThemeContext';

const GITHUB_BASE = 'https://github.com/Fortigi/IdentityAtlas';
const DOCS_URL = 'https://fortigi.github.io/IdentityAtlas';
const SUPPORT_EMAIL = 'support@identityatlas.io';

function formatNumber(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000)    return (n / 1_000).toFixed(0) + 'k';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function formatRelativeTime(isoStr) {
  if (!isoStr) return 'never';
  const then = new Date(isoStr).getTime();
  const diff = Date.now() - then;
  if (diff < 0) return 'in the future';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1)  return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)   return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30)    return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12)  return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export default function DashboardPage({ onNavigate }) {
  const { authFetch } = useAuth();
  const isDark = useIsDark();
  const [stats, setStats] = useState(null);
  const [version, setVersion] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      authFetch('/api/admin/dashboard-stats').then(r => r.ok ? r.json() : null).catch(() => null),
      authFetch('/api/version').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([s, v]) => {
      if (cancelled) return;
      setStats(s);
      setVersion(v);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [authFetch]);

  const hasData = stats?.hasData;

  return (
    <div className="min-h-screen bg-white dark:bg-gray-900">
      <div className="max-w-6xl mx-auto px-4 py-10">
        {/* Header with big logo */}
        <div className="mb-10 flex flex-col sm:flex-row items-center sm:items-end gap-6">
          <img
            src="/logo.png"
            alt="Identity Atlas"
            className="w-40 h-40 sm:w-48 sm:h-48 flex-shrink-0 drop-shadow-[0_0_35px_rgba(132,204,22,0.3)] dark:brightness-90 dark:drop-shadow-[0_0_20px_rgba(132,204,22,0.15)]"
          />
          <div className="flex-1 pb-4 text-center sm:text-left">
            <p className="text-base text-gray-700 dark:text-gray-300 leading-relaxed max-w-xl">
              Universal authorization intelligence — sync, analyze, and govern
              permissions from any identity system.
            </p>
          </div>
        </div>

      {/* Compose file outdated warning */}
      {version?.composeFileOutdated && (
        <div className="mb-6 rounded-xl border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 p-4 text-sm">
          <div className="font-semibold text-amber-800 dark:text-amber-300 mb-1">Your docker-compose file is outdated</div>
          <p className="text-amber-700 dark:text-amber-400">
            The running image expects compose file version {version.minComposeFileVersion} but your file is version {version.composeFileVersion || 'unknown'}.
            Re-download the latest version to get new settings (volume mounts, security fixes, etc.):
          </p>
          <code className="block mt-2 px-3 py-2 bg-amber-100 dark:bg-amber-900/50 rounded text-xs font-mono text-amber-900 dark:text-amber-200">
            curl -O https://raw.githubusercontent.com/Fortigi/IdentityAtlas/main/docker-compose.prod.yml
          </code>
        </div>
      )}

      {/* Main 2-column layout: brain graph + stats */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Brain graph */}
        <div
          className="rounded-2xl p-6 flex items-center justify-center relative overflow-hidden shadow-lg ring-1 ring-lime-200/60 dark:ring-gray-700"
          style={{
            background: isDark
              ? '#1f2937'
              : 'radial-gradient(ellipse at 30% 20%, #ffffff 0%, #f7fee7 50%, #ecfccb 100%)',
          }}
        >
          <BrainGraph stats={stats} loading={loading} isDark={isDark} />
        </div>

        {/* Stats grid */}
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-6 shadow-lg ring-1 ring-gray-200 dark:ring-gray-700">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-xs font-bold text-lime-700 uppercase tracking-widest">Loaded data</h2>
            {hasData && (
              <span className="text-xs text-gray-400 dark:text-gray-500">
                Last sync <span className="text-gray-700 dark:text-gray-300">{formatRelativeTime(stats.lastSyncAt)}</span>
              </span>
            )}
          </div>

          {loading ? (
            <div className="text-sm text-gray-500 dark:text-gray-400">Loading…</div>
          ) : !hasData ? (
            <NoDataState onNavigate={onNavigate} />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <StatCard label="Systems"        value={stats.systems}       onClick={() => onNavigate?.('systems')} />
                <StatCard label="Users"          value={stats.users}         onClick={() => onNavigate?.('users')} />
                <StatCard label="Resources"      value={stats.resources}     onClick={() => onNavigate?.('resources')} />
                <StatCard label="Business Roles" value={stats.businessRoles} onClick={() => onNavigate?.('access-packages')} />
                <StatCard label="Identities"     value={stats.identities}    onClick={() => onNavigate?.('identities')} />
                <StatCard label="Contexts"       value={stats.contexts}      onClick={() => onNavigate?.('org-chart')} />
                <StatCard label="Assignments"      value={stats.assignments}     />
                <StatCard label="Relationships"    value={stats.relationships}  />
                <StatCard label="Identity Members" value={stats.identityMembers} onClick={() => onNavigate?.('identities')} />
              </div>
              <div className="mt-5 pt-4 border-t border-gray-100 dark:border-gray-700 text-xs text-gray-400 dark:text-gray-500 text-right">
                <button
                  onClick={() => onNavigate?.('sync-log')}
                  className="hover:text-lime-700 hover:underline transition-colors"
                >
                  {stats.syncLogEntries || 0} sync log entries
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Feature status row */}
      {hasData && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <FeatureCard
            label="Risk Scoring"
            status={stats.activeClassifiers > 0 ? 'Active' : stats.llmConfigured ? 'Ready' : 'Not configured'}
            detail={stats.riskScores > 0 ? `${formatNumber(stats.riskScores)} entities scored` : stats.llmConfigured ? 'LLM configured, no profile yet' : 'Configure in Admin → LLM Settings'}
            ok={stats.activeClassifiers > 0}
            warn={stats.llmConfigured && stats.activeClassifiers === 0}
            onClick={() => onNavigate?.('admin?sub=risk-scoring')}
          />
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
      )}

      {/* Links + version + support */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-10">
        {/* Resources card — green accent */}
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm ring-1 ring-gray-200 dark:ring-gray-700 hover:ring-lime-300 transition-all">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-lg bg-lime-100 flex items-center justify-center">
              <svg className="w-4 h-4 text-lime-700" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>
            </div>
            <h3 className="text-sm font-bold text-gray-900 dark:text-white">Resources</h3>
          </div>
          <ul className="space-y-2.5 text-sm">
            <li><a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="text-gray-700 dark:text-gray-300 hover:text-lime-700 hover:underline flex items-center gap-2"><span>→</span>Documentation</a></li>
            <li><a href={GITHUB_BASE} target="_blank" rel="noopener noreferrer" className="text-gray-700 dark:text-gray-300 hover:text-lime-700 hover:underline flex items-center gap-2"><span>→</span>GitHub repository</a></li>
            <li><a href={`${GITHUB_BASE}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer" className="text-gray-700 dark:text-gray-300 hover:text-lime-700 hover:underline flex items-center gap-2"><span>→</span>License</a></li>
            <li><a href={`${GITHUB_BASE}/releases`} target="_blank" rel="noopener noreferrer" className="text-gray-700 dark:text-gray-300 hover:text-lime-700 hover:underline flex items-center gap-2"><span>→</span>Releases</a></li>
          </ul>
        </div>

        {/* Version card */}
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm ring-1 ring-gray-200 dark:ring-gray-700 hover:ring-lime-300 transition-all">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-lg bg-lime-100 flex items-center justify-center">
              <svg className="w-4 h-4 text-lime-700" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"/></svg>
            </div>
            <h3 className="text-sm font-bold text-gray-900 dark:text-white">Version</h3>
          </div>
          <div className={`font-mono font-semibold text-gray-900 dark:text-white tabular-nums ${version?.version?.length > 10 ? 'text-lg' : 'text-3xl'}`}>
            {version?.version ? `v${version.version}` : 'v5.0'}
          </div>
          <div className="mt-3 text-xs">
            <a href={`${GITHUB_BASE}/blob/main/CHANGES.md`} target="_blank" rel="noopener noreferrer" className="text-lime-700 hover:text-lime-800 font-medium hover:underline inline-flex items-center gap-1">
              What is new →
            </a>
          </div>
        </div>

        {/* Support card */}
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm ring-1 ring-gray-200 dark:ring-gray-700 hover:ring-lime-300 transition-all">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-lg bg-lime-100 flex items-center justify-center">
              <svg className="w-4 h-4 text-lime-700" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            </div>
            <h3 className="text-sm font-bold text-gray-900 dark:text-white">Need support?</h3>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">Questions, bug reports, or feature requests:</p>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="inline-block text-sm text-lime-700 hover:text-lime-800 font-medium hover:underline break-all"
          >
            {SUPPORT_EMAIL}
          </a>
        </div>
      </div>

      {/* Footer */}
      <div className="text-center text-xs text-gray-400 dark:text-gray-500 pb-6">
        Created by{' '}
        <a href="https://www.fortigi.nl" target="_blank" rel="noopener noreferrer" className="hover:underline text-gray-500 dark:text-gray-400 hover:text-lime-700 transition-colors">
          Maatschap Fortigi
        </a>
      </div>
      </div>
    </div>
  );
}

// ─── StatCard ─────────────────────────────────────────────────────────
function StatCard({ label, value, onClick }) {
  const clickable = typeof onClick === 'function' && value > 0;
  const empty = !value;
  return (
    <div
      onClick={clickable ? onClick : undefined}
      className={`p-3 rounded-xl transition-all ${
        clickable
          ? 'cursor-pointer bg-gradient-to-br from-lime-50 to-white dark:from-lime-900/25 dark:to-gray-800 ring-1 ring-lime-200 dark:ring-lime-700/50 hover:ring-lime-500 dark:hover:ring-lime-600 hover:shadow-md hover:-translate-y-0.5'
          : empty
            ? 'bg-gray-50 dark:bg-gray-700/50 ring-1 ring-gray-100 dark:ring-gray-600'
            : 'bg-gradient-to-br from-lime-50 to-white dark:from-lime-900/25 dark:to-gray-800 ring-1 ring-lime-200 dark:ring-lime-700/50'
      }`}
    >
      <div className={`text-2xl font-bold tabular-nums ${empty ? 'text-gray-400 dark:text-gray-500' : 'text-gray-900 dark:text-white'}`}>
        {formatNumber(value)}
      </div>
      <div className={`text-xs mt-0.5 font-medium ${empty ? 'text-gray-400 dark:text-gray-500' : 'text-lime-700'}`}>
        {label}
      </div>
    </div>
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

// ─── NoDataState ──────────────────────────────────────────────────────
function NoDataState({ onNavigate }) {
  return (
    <div className="text-center py-8">
      <div className="text-5xl mb-3">📦</div>
      <div className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        No data loaded yet.
      </div>
      <button
        onClick={() => onNavigate?.('admin')}
        className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700"
      >
        Configure a crawler →
      </button>
      <div className="mt-3 text-xs text-gray-400 dark:text-gray-500">
        Connect Entra ID, upload CSV exports, or click "Load Demo Data" in Admin → Crawlers.
      </div>
    </div>
  );
}

// ─── BrainGraph ───────────────────────────────────────────────────────
//
// SVG brain-network visualisation echoing the Identity Atlas logo. Green
// palette throughout, organic/asymmetric node placement that roughly follows
// a brain outline, curved connection paths for a more biological feel.
// Node sizes scale with entity counts (log scale so millions don't dwarf
// dozens), and active nodes glow + pulse while empty ones stay dim.
function BrainGraph({ stats, loading, isDark }) {
  const svgRef = useRef(null);
  const width = 440;
  const height = 400;

  // Palette switches between light and dark backgrounds.
  const LIME = isDark ? '#84cc16' : '#65a30d';         // active edges
  const EDGE_DIM = isDark ? '#1a4d10' : '#d9f99d';     // inactive edges
  const LABEL_ACTIVE = isDark ? '#a3e635' : '#365314'; // node labels with data
  const LABEL_DIM = isDark ? '#2d5a1a' : '#84cc16';   // node labels empty

  // Hand-positioned to suggest the logo's brain outline — a top-heavy oval
  // with two lobes. Systems crowns the top, Assignments sits in the central
  // core, and the remaining nodes are arranged symmetrically around them to
  // form the brain silhouette. The two new nodes (ID Members, Relationships)
  // are tucked into the lobes rather than dangling at the bottom.
  const NODE_DEFS = [
    { id: 'systems',        label: 'Systems',        key: 'systems',         x: 220, y: 45  },
    { id: 'resources',      label: 'Resources',      key: 'resources',       x: 75,  y: 110 },
    { id: 'users',          label: 'Users',          key: 'users',           x: 365, y: 110 },
    { id: 'relationships',  label: 'Relationships',  key: 'relationships',   x: 68,  y: 200 },
    { id: 'assignments',    label: 'Assignments',    key: 'assignments',     x: 220, y: 165 },
    { id: 'identities',     label: 'Identities',     key: 'identities',      x: 372, y: 200 },
    { id: 'roles',          label: 'Roles',          key: 'businessRoles',   x: 110, y: 275 },
    { id: 'idMembers',      label: 'ID Members',     key: 'identityMembers', x: 330, y: 275 },
    { id: 'certs',          label: 'Reviews',        key: 'certifications',  x: 155, y: 335 },
    { id: 'contexts',       label: 'Contexts',       key: 'contexts',        x: 285, y: 335 },
  ];

  // Edges — many more than before so the graph looks like a dense brain net.
  // Central "assignments" node connects to everything; extra cross-links give
  // the organic brain feel.
  const EDGES = [
    ['systems', 'resources'],
    ['systems', 'users'],
    ['systems', 'contexts'],
    ['systems', 'assignments'],
    ['resources', 'assignments'],
    ['resources', 'relationships'],
    ['users', 'assignments'],
    ['users', 'identities'],
    ['users', 'idMembers'],
    ['users', 'contexts'],
    ['resources', 'roles'],
    ['assignments', 'roles'],
    ['assignments', 'contexts'],
    ['assignments', 'identities'],
    ['identities', 'idMembers'],
    ['identities', 'contexts'],
    ['relationships', 'roles'],
    ['relationships', 'certs'],
    ['resources', 'certs'],
    ['certs', 'roles'],
    ['certs', 'assignments'],
    ['roles', 'contexts'],
  ];

  const radiusFor = (key) => {
    const n = stats?.[key] || 0;
    if (n === 0) return 9;
    const base = 11 + Math.log10(n + 1) * 6;
    return Math.min(26, base);
  };

  const nodeById = Object.fromEntries(NODE_DEFS.map(n => [n.id, n]));

  // Curved edge path: quadratic Bézier with a control point offset
  // perpendicular to the straight line. Deterministic offset based on edge
  // index so edges don't jitter across renders.
  const curvePath = (x1, y1, x2, y2, bendSign) => {
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    // perpendicular unit vector
    const px = -dy / len;
    const py = dx / len;
    const bend = 18 * bendSign;
    const cx = mx + px * bend;
    const cy = my + py * bend;
    return `M ${x1},${y1} Q ${cx},${cy} ${x2},${y2}`;
  };

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-auto"
      style={{ maxHeight: '400px' }}
    >
      <defs>
        {/* Active node gradient — bright lime highlight fading to mid-green */}
        <radialGradient id="node-gradient" cx="35%" cy="30%">
          <stop offset="0%"  stopColor="#d9f99d" stopOpacity="1" />
          <stop offset="40%" stopColor="#a3e635" stopOpacity="1" />
          <stop offset="100%" stopColor="#65a30d" stopOpacity="1" />
        </radialGradient>

        {/* Empty node — adapts to background */}
        <radialGradient id="node-gradient-dim" cx="35%" cy="30%">
          <stop offset="0%"  stopColor={isDark ? '#1a3a10' : '#f7fee7'} stopOpacity="1" />
          <stop offset="100%" stopColor={isDark ? '#0d2209' : '#ecfccb'} stopOpacity="1" />
        </radialGradient>

        {/* Soft lime glow around active nodes (on light background) */}
        <filter id="green-glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="3.5" result="blur" />
          <feColorMatrix
            in="blur"
            type="matrix"
            values="0 0 0 0 0.64  0 0 0 0 0.90  0 0 0 0 0.21  0 0 0 0.55 0"
          />
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Edges — curved, with subtle pulse on active links */}
      <g>
        {EDGES.map(([a, b], i) => {
          const na = nodeById[a];
          const nb = nodeById[b];
          if (!na || !nb) return null;
          const active = (stats?.[na.key] || 0) > 0 && (stats?.[nb.key] || 0) > 0;
          const bendSign = i % 2 === 0 ? 1 : -1;
          const d = curvePath(na.x, na.y, nb.x, nb.y, bendSign);
          return (
            <g key={i}>
              {/* Outer glow trace — wider, lighter, behind the main stroke */}
              {active && (
                <path
                  d={d}
                  stroke="#a3e635"
                  strokeWidth="4"
                  strokeLinecap="round"
                  fill="none"
                  opacity={isDark ? 0.25 : 0.35}
                />
              )}
              {/* Main stroke */}
              <path
                d={d}
                stroke={active ? LIME : EDGE_DIM}
                strokeWidth={active ? 1.75 : 1}
                strokeLinecap="round"
                fill="none"
                strokeDasharray={active ? '' : '3,3'}
                opacity={active ? 0.85 : 0.7}
              >
                {active && (
                  <animate
                    attributeName="stroke-opacity"
                    values="0.6;1;0.6"
                    dur={`${5 + (i % 4)}s`}
                    repeatCount="indefinite"
                    begin={`${(i * 0.37) % 3}s`}
                  />
                )}
              </path>
            </g>
          );
        })}
      </g>

      {/* Nodes */}
      <g>
        {NODE_DEFS.map((n, i) => {
          const r = radiusFor(n.key);
          const count = stats?.[n.key] || 0;
          const active = count > 0;
          return (
            <g key={n.id}>
              {/* Outer halo ring for active nodes */}
              {active && (
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={r + 4}
                  fill="none"
                  stroke="#a3e635"
                  strokeWidth="1.2"
                  opacity="0.45"
                >
                  <animate
                    attributeName="r"
                    values={`${r + 4};${r + 8};${r + 4}`}
                    dur={`${3.5 + i * 0.25}s`}
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="opacity"
                    values="0.45;0.05;0.45"
                    dur={`${3.5 + i * 0.25}s`}
                    repeatCount="indefinite"
                  />
                </circle>
              )}
              {/* Main node */}
              <circle
                cx={n.x}
                cy={n.y}
                r={r}
                fill={active ? 'url(#node-gradient)' : 'url(#node-gradient-dim)'}
                stroke={active ? '#4d7c0f' : '#bef264'}
                strokeWidth={active ? 1.75 : 1.25}
                filter={active ? 'url(#green-glow)' : undefined}
              >
                {active && (
                  <animate
                    attributeName="r"
                    values={`${r};${r + 1};${r}`}
                    dur={`${2.8 + i * 0.18}s`}
                    repeatCount="indefinite"
                  />
                )}
              </circle>
              {/* Count — dark green, high contrast on the bright lime body */}
              <text
                x={n.x}
                y={n.y + 3.5}
                textAnchor="middle"
                style={{
                  fontSize: '10px',
                  fontWeight: 800,
                  pointerEvents: 'none',
                  fill: active ? '#1a2e05' : '#84cc16',
                }}
              >
                {loading ? '' : formatNumber(count)}
              </text>
              {/* Label below */}
              <text
                x={n.x}
                y={n.y + r + 14}
                textAnchor="middle"
                style={{
                  fontSize: '10px',
                  fontWeight: 600,
                  fill: active ? LABEL_ACTIVE : LABEL_DIM,
                  letterSpacing: '0.02em',
                }}
              >
                {n.label}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
