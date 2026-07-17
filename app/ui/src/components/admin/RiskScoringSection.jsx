import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { useFetch } from '@ui/hooks/useFetch';
import { useAuth } from '@ui/auth/AuthGate';
import { MetaBadge, JsonViewer, Section, NotConfigured } from './adminUi';
import { RiskProfileIcon, ClassifiersIcon } from './adminIcons';
import { fmt } from './adminFormat';
const RiskProfileWizard = lazy(() => import('../RiskProfileWizard'));
function RiskProfileSection() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const { authFetch } = useAuth();

  useEffect(() => {
    authFetch('/api/admin/risk-profile')
      .then(r => r.json())
      .then(setData)
      .catch(() => setData({ available: false }))
      .finally(() => setLoading(false));
  }, [authFetch]);

  const content = () => {
    if (loading) return <p className="mt-4 text-sm text-gray-600 dark:text-gray-500">Loading...</p>;
    if (!data?.available) {
      return (
        <div className="mt-4">
          <NotConfigured message="No risk profile saved yet. Open Admin → Risk Scoring → New profile to generate one via the wizard." />
        </div>
      );
    }

    const cp = data.profile || {};
    const regulations = cp.regulations || [];
    const criticalRoles = cp.critical_roles || [];
    const knownSystems = cp.known_systems || [];
    const criticalProcesses = cp.critical_business_processes || [];
    const riskDomains = cp.risk_domains || [];

    return (
      <div className="mt-4 space-y-4">
        <div className="flex flex-wrap gap-2">
          {!data.isActive && (
            <span className="px-2 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 text-xs rounded-full border border-amber-200 dark:border-amber-700">
              Not active — showing most recent
            </span>
          )}
          <MetaBadge label="Name" value={data.displayName || cp.name} />
          <MetaBadge label="Domain" value={data.domain} />
          <MetaBadge label="Industry" value={data.industry} />
          <MetaBadge label="Country" value={data.country} />
          <MetaBadge label="LLM" value={`${data.llmProvider || '—'} ${data.llmModel || ''}`.trim()} />
          <MetaBadge label="Version" value={`v${data.version}`} />
          <MetaBadge label="Generated" value={fmt(data.generatedAt)} />
        </div>

        {cp.description && (
          <div>
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Organization Description</p>
            <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">{cp.description}</p>
          </div>
        )}

        {regulations.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Applicable Regulations ({regulations.length})</p>
            <div className="flex flex-wrap gap-1.5">
              {regulations.map((r, i) => (
                <span
                  key={i}
                  title={r.relevance || ''}
                  className="px-2 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-xs rounded-full border border-blue-200 dark:border-blue-700"
                >
                  {r.name || r.id || String(r)}
                </span>
              ))}
            </div>
          </div>
        )}

        {criticalRoles.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Critical Roles ({criticalRoles.length})</p>
            <div className="space-y-1">
              {criticalRoles.map((r, i) => {
                const titles = Array.isArray(r.title_patterns) ? r.title_patterns.join(', ') : (r.title || String(r));
                return (
                  <div key={i} className="text-xs text-gray-700 dark:text-gray-300 flex gap-2">
                    <span className="font-mono text-gray-500 dark:text-gray-400 shrink-0">{titles}</span>
                    {r.rationale && <span className="text-gray-500 dark:text-gray-400">— {r.rationale}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {knownSystems.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Known Systems ({knownSystems.length})</p>
            <div className="flex flex-wrap gap-1.5">
              {knownSystems.map((s, i) => (
                <span
                  key={i}
                  title={s.description || s.type || ''}
                  className={`px-2 py-0.5 text-xs rounded-full border ${
                    s.criticality === 'critical' ? 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200 dark:border-red-700' :
                    s.criticality === 'high' ? 'bg-orange-50 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-700' :
                    'bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-600'
                  }`}
                >
                  {s.name || String(s)}
                </span>
              ))}
            </div>
          </div>
        )}

        {criticalProcesses.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Critical Business Processes ({criticalProcesses.length})</p>
            <ul className="text-xs text-gray-700 dark:text-gray-300 space-y-0.5 list-disc list-inside">
              {criticalProcesses.map((p, i) => <li key={i}>{typeof p === 'string' ? p : (p.name || JSON.stringify(p))}</li>)}
            </ul>
          </div>
        )}

        {riskDomains.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Risk Domains ({riskDomains.length})</p>
            <div className="flex flex-wrap gap-1.5">
              {riskDomains.map((d, i) => (
                <span
                  key={i}
                  title={d.description || ''}
                  className="px-2 py-0.5 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 text-xs rounded-full border border-purple-200 dark:border-purple-700"
                >
                  {d.domain || d.name || String(d)}
                  {d.weight != null && <span className="ml-1 text-[10px] text-purple-500 dark:text-purple-400">{d.weight}</span>}
                </span>
              ))}
            </div>
          </div>
        )}

        <JsonViewer data={data.profile} />
      </div>
    );
  };

  return <Section title="Risk Profile" icon={<RiskProfileIcon />} defaultOpen>{content()}</Section>;
}

// ── Classifiers section ───────────────────────────────────────────
//
// v5 classifier shape (matches riskPrompts.js classifierGenerationPrompt):
//   { version, groupClassifiers:[], userClassifiers:[], agentClassifiers:[] }
// each classifier: { id, label, description, patterns:[], score, tier, domain }

const TIER_STYLES_SMALL = {
  critical: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300',
  high:     'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300',
  medium:   'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300',
  low:      'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
};

function ClassifierTable({ rules, emptyMsg }) {
  if (!rules?.length) return <p className="text-xs text-gray-600 dark:text-gray-500 mt-2">{emptyMsg}</p>;
  return (
    <div className="mt-2 overflow-x-auto rounded border border-gray-200 dark:border-gray-700">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-gray-50 dark:bg-gray-700/50 text-left text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            <th className="px-3 py-2 font-semibold">Label</th>
            <th className="px-3 py-2 font-semibold">Patterns</th>
            <th className="px-3 py-2 font-semibold w-16 text-center">Score</th>
            <th className="px-3 py-2 font-semibold w-20 text-center">Tier</th>
            <th className="px-3 py-2 font-semibold">Domain</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {rules.map((rule, i) => {
            const patterns = Array.isArray(rule.patterns) ? rule.patterns : (rule.patterns ? [rule.patterns] : []);
            const tier = (rule.tier || '').toLowerCase();
            return (
              <tr key={rule.id || i} className="hover:bg-gray-50 dark:hover:bg-gray-700/30 align-top">
                <td className="px-3 py-2 font-medium text-gray-800 dark:text-gray-200">
                  {rule.label || rule.id || '—'}
                  {rule.description && (
                    <p className="text-gray-600 dark:text-gray-500 font-normal mt-0.5 leading-relaxed">{rule.description}</p>
                  )}
                </td>
                <td className="px-3 py-2 text-gray-600 dark:text-gray-400 font-mono">
                  {patterns.length === 0 ? '—' : (
                    <div className="space-y-0.5">
                      {patterns.map((p, pi) => <div key={pi}>{p}</div>)}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-center">
                  <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${
                    (rule.score || 0) >= 70 ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300' :
                    (rule.score || 0) >= 40 ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300' :
                    'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                  }`}>{rule.score ?? '—'}</span>
                </td>
                <td className="px-3 py-2 text-center">
                  {tier ? (
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${TIER_STYLES_SMALL[tier] || 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'}`}>
                      {tier}
                    </span>
                  ) : '—'}
                </td>
                <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{rule.domain || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ClassifiersSection() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('groups');
  const { authFetch } = useAuth();

  useEffect(() => {
    authFetch('/api/admin/classifiers')
      .then(r => r.json())
      .then(d => { setData(d); })
      .catch(() => setData({ available: false }))
      .finally(() => setLoading(false));
  }, [authFetch]);

  const content = () => {
    if (loading) return <p className="mt-4 text-sm text-gray-600 dark:text-gray-500">Loading...</p>;
    if (!data?.available) {
      return (
        <div className="mt-4">
          <NotConfigured message="No classifiers saved yet. Open Admin → Risk Scoring → New profile to generate a profile and classifier set via the wizard." />
        </div>
      );
    }

    const cls = data.classifiers || {};
    const groupRules = cls.groupClassifiers || [];
    const userRules  = cls.userClassifiers  || [];
    const agentRules = cls.agentClassifiers || [];

    return (
      <div className="mt-4 space-y-3">
        <div className="flex flex-wrap gap-2">
          {!data.isActive && (
            <span className="px-2 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 text-xs rounded-full border border-amber-200 dark:border-amber-700">
              Not active — showing most recent
            </span>
          )}
          <MetaBadge label="Name" value={data.displayName} />
          <MetaBadge label="Version" value={`v${data.version}`} />
          <MetaBadge label="LLM" value={`${data.llmProvider || '—'} ${data.llmModel || ''}`.trim()} />
          <MetaBadge label="Generated" value={fmt(data.generatedAt)} />
          <MetaBadge label="Groups" value={groupRules.length} />
          <MetaBadge label="Users"  value={userRules.length} />
          <MetaBadge label="Agents" value={agentRules.length} />
        </div>

        {/* Sub-tabs */}
        <div className="flex gap-2 border-b border-gray-200 dark:border-gray-700 mt-2">
          {[
            ['groups', `Groups (${groupRules.length})`],
            ['users',  `Users (${userRules.length})`],
            ['agents', `Agents (${agentRules.length})`],
          ].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`pb-2 px-1 text-sm font-medium border-b-2 transition-colors ${
                activeTab === key
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {activeTab === 'groups' && <ClassifierTable rules={groupRules} emptyMsg="No group classifiers." />}
        {activeTab === 'users'  && <ClassifierTable rules={userRules}  emptyMsg="No user classifiers." />}
        {activeTab === 'agents' && <ClassifierTable rules={agentRules} emptyMsg="No agent classifiers." />}

        {data.isActive && (
          <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              While active, risk scoring runs automatically after every crawl. Use Run now above for an ad-hoc run.
            </p>
          </div>
        )}

        <JsonViewer data={data.classifiers} />
      </div>
    );
  };

  return <Section title="Risk Classifiers" icon={<ClassifiersIcon />}>{content()}</Section>;
}

function NewRiskProfileLauncher({ onRiskScoresRefresh }) {
  const [open, setOpen] = useState(false);
  const [bumpKey, setBumpKey] = useState(0);
  return (
    <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded-lg p-4 flex items-center justify-between">
      <div>
        <div className="text-sm font-medium text-blue-900 dark:text-blue-200">Create a new risk profile</div>
        <div className="text-xs text-blue-700 dark:text-blue-300 mt-0.5">
          Walks you through generating an organisational profile and classifier set with the LLM, then optionally runs a scoring pass.
        </div>
      </div>
      <button onClick={() => setOpen(true)} className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">
        New profile
      </button>
      {open && (
        <Suspense fallback={null}>
          <RiskProfileWizard
            key={bumpKey}
            onClose={() => setOpen(false)}
            onSaved={() => { setBumpKey(k => k + 1); onRiskScoresRefresh?.(); }}
          />
        </Suspense>
      )}
    </div>
  );
}

// ─── Risk Scoring sub-tab — combines profile + classifiers + feature toggle ──
export default function RiskScoringSection({ onRiskScoresRefresh }) {
  const { authFetch } = useAuth();
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState(null);
  const [runErr, setRunErr] = useState(null);

  // /api/features is public (no auth header needed); use a stable plain-fetch
  // wrapper so useFetch's identity-based effect doesn't refetch every render.
  const plainFetch = useCallback((u) => fetch(u), []);
  const { data: features } = useFetch('/api/features', { authFetch: plainFetch });

  const handleToggle = async () => {
    if (!features) return;
    setToggling(true);
    setError(null);
    try {
      const r = await authFetch('/api/admin/features/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: 'riskScoring', enabled: !features.riskScoring }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      // Hard reload so the main navigation tabs (Risk Scores, Org Chart) re-evaluate
      // their visibility against the new feature flags. A re-fetch alone wouldn't
      // re-run the nav tab filter logic in App.jsx until the user navigates away.
      window.location.reload();
    } catch (err) {
      setError(err.message);
      setToggling(false);
    }
  };

  const runNow = async () => {
    setRunning(true); setRunMsg(null); setRunErr(null);
    try {
      const r = await authFetch('/api/risk-scoring/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRunMsg('Risk scoring started — follow progress in the Logs tab.');
      if (onRiskScoresRefresh) setTimeout(onRiskScoresRefresh, 4000);
    } catch (e) {
      setRunErr(e.message);
    } finally {
      setRunning(false);
    }
  };

  const enabled = features?.riskScoring !== false;

  return (
    <div className="space-y-4">
      {/* Feature toggle card */}
      <div className={`rounded-lg border p-5 ${enabled ? 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700' : 'bg-gray-50 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600'}`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">Risk Scoring Feature</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              Risk scoring assigns a 0-100 risk score to every identity based on direct classifier matches,
              membership analysis, structural hygiene checks, and cross-entity propagation.
              When disabled, the Risk Scores tab is hidden from the main navigation and the scoring engine
              is skipped during sync runs.
            </p>
            {error && (
              <div className="mt-3 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded text-sm text-red-700 dark:text-red-300">{error}</div>
            )}
          </div>
          <div className="flex-shrink-0">
            <button
              onClick={handleToggle}
              disabled={toggling || features === null}
              className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                enabled ? 'bg-emerald-600' : 'bg-gray-300 dark:bg-gray-600'
              } disabled:opacity-50`}
              title={enabled ? 'Disable risk scoring' : 'Enable risk scoring'}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                  enabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
            <div className="text-xs text-gray-500 dark:text-gray-400 text-center mt-1">
              {toggling ? '...' : enabled ? 'Enabled' : 'Disabled'}
            </div>
          </div>
        </div>
      </div>

      {/* Risk profile + classifiers — only render when feature is enabled */}
      {enabled ? (
        <>
          <NewRiskProfileLauncher onRiskScoresRefresh={onRiskScoresRefresh} />

          {/* Run now */}
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-gray-900 dark:text-white">Run risk scoring</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  Scoring runs automatically after every crawl. Use this to re-score the active classifier on demand.
                </p>
                {runMsg && <div className="mt-2 text-sm text-emerald-700 dark:text-emerald-300">{runMsg}</div>}
                {runErr && <div className="mt-2 text-sm text-red-700 dark:text-red-300">{runErr}</div>}
              </div>
              <button
                onClick={runNow}
                disabled={running}
                className="flex-shrink-0 px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {running ? 'Starting…' : 'Run now'}
              </button>
            </div>
          </div>

          <RiskProfileSection />
          <ClassifiersSection />
        </>
      ) : (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-6 text-center text-sm text-gray-500 dark:text-gray-400">
          Risk Scoring is disabled. Enable the feature toggle above to configure profiles and classifiers.
        </div>
      )}
    </div>
  );
}