import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { useAuth } from '../auth/AuthGate';
import ScheduleEditor from './ScheduleEditor';

// Lazy-load the heavy sub-tab pages so they don't bloat the initial Admin bundle
const CrawlersPage = lazy(() => import('./CrawlersPage'));
const ContainerStatsPage = lazy(() => import('./ContainerStatsPage'));
const AuthSettingsPage = lazy(() => import('./AuthSettingsPage'));
const PerfPage = lazy(() => import('./PerfPage'));
const RiskProfileWizard = lazy(() => import('./RiskProfileWizard'));
const CorrelationWizard = lazy(() => import('./CorrelationWizard'));

// ── Helpers ───────────────────────────────────────────────────────

function fmt(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleString();
  } catch {
    return dateStr;
  }
}

function MetaBadge({ label, value }) {
  if (!value) return null;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs">
      <span className="text-gray-400">{label}:</span>
      <span className="font-medium">{value}</span>
    </span>
  );
}

function JsonViewer({ data }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors"
      >
        <svg className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        {open ? 'Hide' : 'Show'} raw JSON
      </button>
      {open && (
        <pre className="mt-2 p-3 bg-gray-900 text-gray-100 text-xs rounded-lg overflow-auto max-h-96 leading-relaxed">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

function Section({ title, icon, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-lg">{icon}</span>
          <span className="font-medium text-gray-900">{title}</span>
        </div>
        <svg className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="px-5 pb-5 pt-0 border-t border-gray-100">{children}</div>}
    </div>
  );
}

function NotConfigured({ message }) {
  return (
    <div className="mt-4 flex items-center gap-2 text-sm text-gray-400">
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      {message}
    </div>
  );
}

// ── Risk Profile section ──────────────────────────────────────────
//
// Renders the currently active v5 RiskProfiles row. The profile JSON shape
// comes from the in-browser wizard (Admin → Risk Scoring → New profile) and
// maps directly to the `customer_profile` fields produced by the classifier
// generation prompt: name, domain, industry, country, description, regulations,
// critical_business_processes, known_systems, critical_roles, risk_domains.

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
    if (loading) return <p className="mt-4 text-sm text-gray-400">Loading...</p>;
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
            <span className="px-2 py-0.5 bg-amber-50 text-amber-700 text-xs rounded-full border border-amber-200">
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
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Organization Description</p>
            <p className="text-sm text-gray-700 leading-relaxed">{cp.description}</p>
          </div>
        )}

        {regulations.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Applicable Regulations ({regulations.length})</p>
            <div className="flex flex-wrap gap-1.5">
              {regulations.map((r, i) => (
                <span
                  key={i}
                  title={r.relevance || ''}
                  className="px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded-full border border-blue-200"
                >
                  {r.name || r.id || String(r)}
                </span>
              ))}
            </div>
          </div>
        )}

        {criticalRoles.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Critical Roles ({criticalRoles.length})</p>
            <div className="space-y-1">
              {criticalRoles.map((r, i) => {
                const titles = Array.isArray(r.title_patterns) ? r.title_patterns.join(', ') : (r.title || String(r));
                return (
                  <div key={i} className="text-xs text-gray-700 flex gap-2">
                    <span className="font-mono text-gray-500 shrink-0">{titles}</span>
                    {r.rationale && <span className="text-gray-500">— {r.rationale}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {knownSystems.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Known Systems ({knownSystems.length})</p>
            <div className="flex flex-wrap gap-1.5">
              {knownSystems.map((s, i) => (
                <span
                  key={i}
                  title={s.description || s.type || ''}
                  className={`px-2 py-0.5 text-xs rounded-full border ${
                    s.criticality === 'critical' ? 'bg-red-50 text-red-700 border-red-200' :
                    s.criticality === 'high' ? 'bg-orange-50 text-orange-700 border-orange-200' :
                    'bg-gray-50 text-gray-700 border-gray-200'
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
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Critical Business Processes ({criticalProcesses.length})</p>
            <ul className="text-xs text-gray-700 space-y-0.5 list-disc list-inside">
              {criticalProcesses.map((p, i) => <li key={i}>{typeof p === 'string' ? p : (p.name || JSON.stringify(p))}</li>)}
            </ul>
          </div>
        )}

        {riskDomains.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Risk Domains ({riskDomains.length})</p>
            <div className="flex flex-wrap gap-1.5">
              {riskDomains.map((d, i) => (
                <span
                  key={i}
                  title={d.description || ''}
                  className="px-2 py-0.5 bg-purple-50 text-purple-700 text-xs rounded-full border border-purple-200"
                >
                  {d.domain || d.name || String(d)}
                  {d.weight != null && <span className="ml-1 text-[10px] text-purple-500">{d.weight}</span>}
                </span>
              ))}
            </div>
          </div>
        )}

        <JsonViewer data={data.profile} />
      </div>
    );
  };

  return <Section title="Risk Profile" icon="🏢" defaultOpen>{content()}</Section>;
}

// ── Classifiers section ───────────────────────────────────────────
//
// v5 classifier shape (matches riskPrompts.js classifierGenerationPrompt):
//   { version, groupClassifiers:[], userClassifiers:[], agentClassifiers:[] }
// each classifier: { id, label, description, patterns:[], score, tier, domain }

const TIER_STYLES_SMALL = {
  critical: 'bg-red-100 text-red-700',
  high:     'bg-orange-100 text-orange-700',
  medium:   'bg-yellow-100 text-yellow-700',
  low:      'bg-blue-100 text-blue-700',
};

function ClassifierTable({ rules, emptyMsg }) {
  if (!rules?.length) return <p className="text-xs text-gray-400 mt-2">{emptyMsg}</p>;
  return (
    <div className="mt-2 overflow-x-auto rounded border border-gray-200">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-gray-50 text-left text-gray-500 uppercase tracking-wide">
            <th className="px-3 py-2 font-semibold">Label</th>
            <th className="px-3 py-2 font-semibold">Patterns</th>
            <th className="px-3 py-2 font-semibold w-16 text-center">Score</th>
            <th className="px-3 py-2 font-semibold w-20 text-center">Tier</th>
            <th className="px-3 py-2 font-semibold">Domain</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rules.map((rule, i) => {
            const patterns = Array.isArray(rule.patterns) ? rule.patterns : (rule.patterns ? [rule.patterns] : []);
            const tier = (rule.tier || '').toLowerCase();
            return (
              <tr key={rule.id || i} className="hover:bg-gray-50 align-top">
                <td className="px-3 py-2 font-medium text-gray-800">
                  {rule.label || rule.id || '—'}
                  {rule.description && (
                    <p className="text-gray-400 font-normal mt-0.5 leading-relaxed">{rule.description}</p>
                  )}
                </td>
                <td className="px-3 py-2 text-gray-600 font-mono">
                  {patterns.length === 0 ? '—' : (
                    <div className="space-y-0.5">
                      {patterns.map((p, pi) => <div key={pi}>{p}</div>)}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-center">
                  <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${
                    (rule.score || 0) >= 70 ? 'bg-red-100 text-red-700' :
                    (rule.score || 0) >= 40 ? 'bg-orange-100 text-orange-700' :
                    'bg-gray-100 text-gray-600'
                  }`}>{rule.score ?? '—'}</span>
                </td>
                <td className="px-3 py-2 text-center">
                  {tier ? (
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${TIER_STYLES_SMALL[tier] || 'bg-gray-100 text-gray-500'}`}>
                      {tier}
                    </span>
                  ) : '—'}
                </td>
                <td className="px-3 py-2 text-gray-600">{rule.domain || '—'}</td>
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
  const [schedules, setSchedules] = useState([]);
  const [savingSchedules, setSavingSchedules] = useState(false);
  const [scheduleError, setScheduleError] = useState(null);
  const { authFetch } = useAuth();

  useEffect(() => {
    authFetch('/api/admin/classifiers')
      .then(r => r.json())
      .then(d => {
        setData(d);
        // Load schedules if classifier is active
        if (d?.isActive && d?.schedules) {
          setSchedules(d.schedules);
        }
      })
      .catch(() => setData({ available: false }))
      .finally(() => setLoading(false));
  }, [authFetch]);

  const handleSaveSchedules = async () => {
    if (!data?.id) return;
    setSavingSchedules(true);
    setScheduleError(null);
    try {
      const res = await authFetch(`/api/risk-classifiers/${data.id}/schedules`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedules }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      alert('Schedules saved successfully');
    } catch (err) {
      setScheduleError(err.message);
    } finally {
      setSavingSchedules(false);
    }
  };

  const content = () => {
    if (loading) return <p className="mt-4 text-sm text-gray-400">Loading...</p>;
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
            <span className="px-2 py-0.5 bg-amber-50 text-amber-700 text-xs rounded-full border border-amber-200">
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
        <div className="flex gap-2 border-b border-gray-200 mt-2">
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
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {activeTab === 'groups' && <ClassifierTable rules={groupRules} emptyMsg="No group classifiers." />}
        {activeTab === 'users'  && <ClassifierTable rules={userRules}  emptyMsg="No user classifiers." />}
        {activeTab === 'agents' && <ClassifierTable rules={agentRules} emptyMsg="No agent classifiers." />}

        {/* Schedules section (only show for active classifier) */}
        {data.isActive && (
          <div className="mt-6 pt-4 border-t border-gray-200">
            <h4 className="text-sm font-semibold mb-2">Automatic Scoring Schedules</h4>
            <p className="text-xs text-gray-500 mb-3">
              Configure when risk scoring runs automatically. Schedules re-run the active classifiers over the latest data.
            </p>

            {schedules.length === 0 && (
              <div className="mb-3 p-4 bg-gray-50 border border-gray-200 rounded text-center text-sm text-gray-500">
                No schedules configured. Scoring will only run when triggered manually.
              </div>
            )}

            {schedules.map((s, i) => (
              <ScheduleEditor key={i}
                schedule={{ enabled: true, ...s }}
                onChange={(updated) => setSchedules(schedules.map((x, idx) => idx === i ? { ...updated, enabled: true } : x))}
                onRemove={() => setSchedules(schedules.filter((_, idx) => idx !== i))}
              />
            ))}

            <div className="flex gap-2 items-center">
              <button onClick={() => setSchedules([...schedules, { enabled: true, frequency: 'daily', hour: 2, minute: 0 }])}
                className="px-3 py-1.5 text-xs bg-gray-200 rounded hover:bg-gray-300">
                + Add Schedule
              </button>
              <button onClick={handleSaveSchedules} disabled={savingSchedules}
                className="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50">
                {savingSchedules ? 'Saving...' : 'Save Schedules'}
              </button>
              {scheduleError && <span className="text-xs text-red-600">{scheduleError}</span>}
            </div>
          </div>
        )}

        <JsonViewer data={data.classifiers} />
      </div>
    );
  };

  return <Section title="Risk Classifiers" icon="🎯">{content()}</Section>;
}

// ── Correlation Ruleset section ───────────────────────────────────

// ── New Correlation Ruleset launcher (opens the wizard) ───────────
function NewCorrelationRulesetLauncher({ onRefresh }) {
  const [open, setOpen] = useState(false);
  const [bumpKey, setBumpKey] = useState(0);

  const handleSaved = () => {
    setBumpKey(k => k + 1);
    onRefresh?.();
  };

  return (
    <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 flex items-center justify-between mb-4">
      <div>
        <div className="text-sm font-medium text-indigo-900">Create a new account correlation ruleset</div>
        <div className="text-xs text-indigo-700 mt-0.5">
          Generates correlation signals and account type rules to link accounts across systems.
        </div>
      </div>
      <button onClick={() => setOpen(true)} className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700">
        New Ruleset
      </button>
      {open && (
        <Suspense fallback={null}>
          <CorrelationWizard
            key={bumpKey}
            onClose={() => setOpen(false)}
            onSaved={handleSaved}
          />
        </Suspense>
      )}
    </div>
  );
}

function CorrelationSection() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('signals');
  const { authFetch } = useAuth();

  const loadData = () => {
    setLoading(true);
    authFetch('/api/admin/correlation-ruleset')
      .then(r => r.json())
      .then(setData)
      .catch(() => setData({ available: false }))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadData();
  }, [authFetch]); // eslint-disable-line react-hooks/exhaustive-deps

  const content = () => {
    if (loading) return <p className="mt-4 text-sm text-gray-400">Loading...</p>;
    if (!data?.available) {
      return (
        <div className="mt-4">
          <NewCorrelationRulesetLauncher onRefresh={loadData} />
          <NotConfigured message="No correlation ruleset saved yet. Click 'New Ruleset' above to create one via the wizard." />
        </div>
      );
    }

    const rs = data.ruleset || {};
    const signals = rs.correlationSignals || rs.correlation_signals || [];
    const accountTypeRules = rs.accountTypeRules || rs.account_type_rules || [];
    const hrConfig = rs.hrSourceConfig || rs.hr_source_config || null;

    return (
      <div className="mt-4 space-y-3">
        <NewCorrelationRulesetLauncher onRefresh={loadData} />

        <div className="flex flex-wrap gap-2">
          <MetaBadge label="Version" value={data.version} />
          <MetaBadge label="Generated" value={fmt(data.generatedAt)} />
          <MetaBadge label="Signals" value={signals.length} />
          <MetaBadge label="Account type rules" value={accountTypeRules.length} />
          {hrConfig?.enabled && <MetaBadge label="HR source" value="Enabled" />}
        </div>

        {/* Sub-tabs */}
        <div className="flex gap-2 border-b border-gray-200 mt-2">
          {[
            ['signals', `Correlation Signals (${signals.length})`],
            ['accountTypes', `Account Types (${accountTypeRules.length})`],
            ...(hrConfig ? [['hr', 'HR Source']] : []),
          ].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`pb-2 px-1 text-sm font-medium border-b-2 transition-colors ${
                activeTab === key
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {activeTab === 'signals' && (
          signals.length === 0
            ? <p className="text-xs text-gray-400 mt-2">No correlation signals defined.</p>
            : <div className="mt-2 overflow-x-auto rounded border border-gray-200">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-50 text-left text-gray-500 uppercase tracking-wide">
                      <th className="px-3 py-2 font-semibold">Signal</th>
                      <th className="px-3 py-2 font-semibold">Type</th>
                      <th className="px-3 py-2 font-semibold">Weight</th>
                      <th className="px-3 py-2 font-semibold">Description</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {signals.map((s, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-3 py-2 font-medium text-gray-800">{s.name || s.signal || '—'}</td>
                        <td className="px-3 py-2 text-gray-600">{s.type || s.matchType || '—'}</td>
                        <td className="px-3 py-2 text-center">
                          <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${
                            (s.weight || 0) >= 70 ? 'bg-green-100 text-green-700' :
                            (s.weight || 0) >= 40 ? 'bg-blue-100 text-blue-700' :
                            'bg-gray-100 text-gray-600'
                          }`}>{s.weight ?? '—'}</span>
                        </td>
                        <td className="px-3 py-2 text-gray-500">{s.description || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
        )}

        {activeTab === 'accountTypes' && (
          accountTypeRules.length === 0
            ? <p className="text-xs text-gray-400 mt-2">No account type rules defined.</p>
            : <div className="mt-2 space-y-2">
                {accountTypeRules.map((rule, i) => (
                  <div key={i} className="p-3 bg-gray-50 rounded border border-gray-200">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-sm text-gray-800">{rule.accountType || rule.type || `Rule ${i + 1}`}</span>
                      {rule.priority !== undefined && (
                        <span className="text-xs text-gray-400">priority {rule.priority}</span>
                      )}
                    </div>
                    {rule.patterns?.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {rule.patterns.map((p, j) => (
                          <code key={j} className="text-xs bg-white px-1.5 py-0.5 rounded border border-gray-200 text-gray-700">{p}</code>
                        ))}
                      </div>
                    )}
                    {rule.description && <p className="text-xs text-gray-500 mt-1">{rule.description}</p>}
                  </div>
                ))}
              </div>
        )}

        {activeTab === 'hr' && hrConfig && (
          <div className="mt-2 p-3 bg-gray-50 rounded border border-gray-200 space-y-2">
            <div className="flex flex-wrap gap-2">
              <MetaBadge label="Enabled" value={hrConfig.enabled ? 'Yes' : 'No'} />
              {hrConfig.sourceSystem && <MetaBadge label="Source" value={hrConfig.sourceSystem} />}
            </div>
            {hrConfig.indicators?.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Indicators</p>
                <div className="overflow-x-auto rounded border border-gray-200">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-white text-left text-gray-500 uppercase tracking-wide">
                        <th className="px-3 py-2 font-semibold">Attribute</th>
                        <th className="px-3 py-2 font-semibold">Value</th>
                        <th className="px-3 py-2 font-semibold">Weight</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {hrConfig.indicators.map((ind, i) => (
                        <tr key={i} className="hover:bg-gray-50">
                          <td className="px-3 py-2 font-mono text-gray-700">{ind.attribute}</td>
                          <td className="px-3 py-2 font-mono text-gray-700">{ind.value}</td>
                          <td className="px-3 py-2 text-center">
                            <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-blue-100 text-blue-700">{ind.weight ?? '—'}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        <JsonViewer data={data.ruleset} />
      </div>
    );
  };

  return <Section title="Account Correlation Ruleset" icon="🔗">{content()}</Section>;
}

// ── Power Query workbook + read-API tokens ────────────────────────
// Lets a tenant admin mint read-only API tokens (`fgr_…`) and download a
// pre-stamped Excel workbook with those credentials baked in. Tokens are
// shown in plaintext exactly once at creation; everywhere else we display
// just the prefix. Revoking a token here flips the `revoked` flag in the DB
// — refresh attempts from any workbook holding that token start failing
// immediately.
function PowerQueryExportSection() {
  const { authFetch } = useAuth();
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [newToken, setNewToken] = useState(null); // plaintext shown once
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');

  const refresh = useCallback(async () => {
    try {
      const r = await authFetch('/api/admin/read-tokens');
      if (r.ok) setTokens(await r.json());
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [authFetch]);

  useEffect(() => { refresh(); }, [refresh]);

  async function downloadWorkbook() {
    setError(null);
    setBusy(true);
    try {
      const r = await authFetch('/api/admin/data-export/workbook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || 'Workbook generation failed');
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `IdentityAtlas-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function createTokenOnly() {
    if (!name.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const r = await authFetch('/api/admin/read-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || 'Token creation failed');
      }
      const data = await r.json();
      setNewToken(data.token);  // plaintext, shown once
      setShowCreate(false);
      setName('');
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id) {
    if (!confirm('Revoke this token? Workbooks using it will stop refreshing immediately.')) return;
    setBusy(true);
    try {
      const r = await authFetch(`/api/admin/read-tokens/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('Revoke failed');
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function fmtDate(s) { return s ? new Date(s).toLocaleString() : '—'; }

  return (
    <Section title="Excel Power Query Workbook" icon="📊">
      <div className="space-y-4 text-sm">
        <p className="text-gray-700">
          Download a pre-configured Excel workbook with Power Query M code for every
          object type (Users, Resources, Assignments, etc). The workbook includes a
          read-only API token so refreshing the data on any user's machine just
          requires opening the file.
        </p>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={downloadWorkbook}
            disabled={busy}
            className="px-4 py-2 rounded text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? 'Generating…' : 'Generate token & download workbook'}
          </button>
          <button
            onClick={() => { setShowCreate(true); setNewToken(null); }}
            disabled={busy}
            className="px-4 py-2 rounded text-sm font-medium text-blue-700 bg-white border border-blue-300 hover:bg-blue-50 disabled:opacity-50"
          >
            Create token only…
          </button>
        </div>

        {showCreate && (
          <div className="flex items-center gap-2 p-3 bg-gray-50 border border-gray-200 rounded">
            <input
              type="text"
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && createTokenOnly()}
              placeholder="Token name (e.g. 'PowerBI prod report')"
              className="px-2 py-1 border border-gray-300 rounded text-sm flex-1"
            />
            <button
              onClick={createTokenOnly}
              disabled={!name.trim() || busy}
              className="px-3 py-1 rounded text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
            >
              Create
            </button>
            <button
              onClick={() => { setShowCreate(false); setName(''); }}
              className="px-2 py-1 rounded text-sm text-gray-500 hover:bg-gray-200"
            >
              Cancel
            </button>
          </div>
        )}

        {newToken && (
          <div className="p-3 bg-amber-50 border border-amber-300 rounded">
            <p className="font-medium text-amber-900 mb-1">⚠ Copy this token now — it will not be shown again</p>
            <code className="block p-2 bg-white border border-amber-200 rounded text-xs break-all font-mono">{newToken}</code>
            <button
              onClick={() => { navigator.clipboard.writeText(newToken); }}
              className="mt-2 px-3 py-1 rounded text-xs font-medium text-amber-900 bg-white border border-amber-300 hover:bg-amber-100"
            >
              Copy to clipboard
            </button>
            <button
              onClick={() => setNewToken(null)}
              className="mt-2 ml-2 px-3 py-1 rounded text-xs text-amber-700 hover:bg-amber-100"
            >
              Dismiss
            </button>
          </div>
        )}

        {error && (
          <div className="p-2 bg-red-50 border border-red-300 rounded text-red-800 text-xs">
            {error}
          </div>
        )}

        <div>
          <h4 className="font-medium text-gray-900 mb-2">Existing tokens</h4>
          {loading ? (
            <p className="text-gray-500 text-xs">Loading…</p>
          ) : tokens.length === 0 ? (
            <p className="text-gray-500 text-xs">No tokens issued yet.</p>
          ) : (
            <table className="w-full text-xs border border-gray-200 rounded overflow-hidden">
              <thead className="bg-gray-50">
                <tr className="text-left">
                  <th className="px-2 py-1 font-medium text-gray-700">Name</th>
                  <th className="px-2 py-1 font-medium text-gray-700">Prefix</th>
                  <th className="px-2 py-1 font-medium text-gray-700">Created</th>
                  <th className="px-2 py-1 font-medium text-gray-700">Last used</th>
                  <th className="px-2 py-1 font-medium text-gray-700">Status</th>
                  <th className="px-2 py-1"></th>
                </tr>
              </thead>
              <tbody>
                {tokens.map(t => (
                  <tr key={t.id} className="border-t border-gray-100">
                    <td className="px-2 py-1 text-gray-900">{t.name}</td>
                    <td className="px-2 py-1 font-mono text-gray-600">{t.tokenPrefix}…</td>
                    <td className="px-2 py-1 text-gray-600">{fmtDate(t.createdAt)}</td>
                    <td className="px-2 py-1 text-gray-600">{fmtDate(t.lastUsedAt)}</td>
                    <td className="px-2 py-1">
                      {t.revoked
                        ? <span className="px-1.5 py-0.5 rounded text-[10px] bg-gray-200 text-gray-700">Revoked</span>
                        : t.expiresAt && new Date(t.expiresAt) < new Date()
                          ? <span className="px-1.5 py-0.5 rounded text-[10px] bg-gray-200 text-gray-700">Expired</span>
                          : <span className="px-1.5 py-0.5 rounded text-[10px] bg-green-100 text-green-800">Active</span>}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {!t.revoked && (
                        <button
                          onClick={() => revoke(t.id)}
                          className="px-2 py-0.5 rounded text-[11px] text-red-700 hover:bg-red-50 border border-red-200"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Section>
  );
}

// ── Curated Data section ──────────────────────────────────────────

function CuratedDataSection() {
  const [exporting, setExporting]   = useState(false);
  const [importing, setImporting]   = useState(false);
  const [importing2, setImporting2] = useState(false); // file-read step
  const [result, setResult]         = useState(null);
  const [error, setError]           = useState(null);
  const fileInputRef = useRef(null);
  const { authFetch } = useAuth();

  async function handleExport() {
    setError(null);
    setExporting(true);
    try {
      const r = await authFetch('/api/admin/export/curated');
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || 'Export failed');
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `FGCuratedData_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  function handleImportClick() {
    setResult(null);
    setError(null);
    fileInputRef.current?.click();
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset so same file can be re-selected
    e.target.value = '';

    setImporting2(true);
    let payload;
    try {
      const text = await file.text();
      payload = JSON.parse(text);
    } catch {
      setError('Could not parse file — make sure it is a valid JSON export.');
      setImporting2(false);
      return;
    }
    setImporting2(false);

    if (!payload.version || (!Array.isArray(payload.tags) && !Array.isArray(payload.categories))) {
      setError('Unrecognised file format. Use a file created by Export-FGCuratedData or this export button.');
      return;
    }

    setImporting(true);
    setError(null);
    try {
      const r = await authFetch('/api/admin/import/curated', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: payload.tags || [], categories: payload.categories || [] }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Import failed');
      setResult(data.stats);
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  }

  const busy = importing || importing2 || exporting;

  return (
    <Section title="Curated Data" icon="📦" defaultOpen>
      <div className="mt-4 space-y-4">
        <p className="text-sm text-gray-500">
          Export and import manually curated data — user tags, group/resource tags, and business role categories —
          so they can be restored after recreating an environment.
          Analyst overrides are managed separately via <code className="bg-gray-100 px-1 rounded text-xs">Export-FGCuratedData</code>.
        </p>

        {/* Buttons */}
        <div className="flex flex-wrap gap-3">
          <button
            onClick={handleExport}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 hover:border-gray-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {exporting ? (
              <svg className="w-4 h-4 animate-spin text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            ) : (
              <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            )}
            {exporting ? 'Exporting…' : 'Export tags & categories'}
          </button>

          <button
            onClick={handleImportClick}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? (
              <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
            )}
            {busy ? 'Importing…' : 'Import from file'}
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            <svg className="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {error}
          </div>
        )}

        {/* Import result */}
        {result && (
          <div className="p-4 bg-green-50 border border-green-200 rounded-lg space-y-3">
            <p className="text-sm font-semibold text-green-800">Import complete</p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Tags */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Tags</p>
                <div className="space-y-1 text-xs text-gray-700">
                  <ResultRow label="Assignments inserted" value={result.assignmentsInserted} good />
                  {result.assignmentsSoftMatched > 0 && (
                    <ResultRow label="Matched by name (soft)" value={result.assignmentsSoftMatched} warn />
                  )}
                  <ResultRow label="Already existed" value={result.assignmentsSkipped} />
                  {result.assignmentsNotFound > 0 && (
                    <ResultRow label="Entity not found" value={result.assignmentsNotFound} bad />
                  )}
                </div>
              </div>

              {/* Categories */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Categories</p>
                <div className="space-y-1 text-xs text-gray-700">
                  <ResultRow label="AP assignments inserted" value={result.catAssignInserted} good />
                  {result.catAssignSoftMatched > 0 && (
                    <ResultRow label="Matched by name (soft)" value={result.catAssignSoftMatched} warn />
                  )}
                  <ResultRow label="Already existed" value={result.catAssignSkipped} />
                  {result.catAssignNotFound > 0 && (
                    <ResultRow label="Business role not found" value={result.catAssignNotFound} bad />
                  )}
                </div>
              </div>
            </div>

            {(result.assignmentsNotFound > 0 || result.catAssignNotFound > 0) && (
              <p className="text-xs text-gray-500">
                Entities not found: run a full sync first so the records exist in SQL, then retry the import.
              </p>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

function ResultRow({ label, value, good, warn, bad }) {
  const color = bad ? 'text-red-600' : warn ? 'text-amber-600' : good && value > 0 ? 'text-green-700' : 'text-gray-600';
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}</span>
      <span className={`font-semibold ${color}`}>{value}</span>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────

// ─── History Retention ────────────────────────────────────────────────────────
// Controls how many days of row-level version history are kept in the
// `_history` audit table. Default 180 days; 0 disables pruning entirely.
function HistoryRetentionSection() {
  const { authFetch } = useAuth();
  const [days, setDays] = useState('');
  const [savedDays, setSavedDays] = useState(null);
  const [totalRows, setTotalRows] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [message, setMessage] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await authFetch('/api/admin/history-retention');
      if (r.ok) {
        const j = await r.json();
        setDays(String(j.retentionDays));
        setSavedDays(j.retentionDays);
        setTotalRows(j.totalRows);
      }
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const r = await authFetch('/api/admin/history-retention', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retentionDays: parseInt(days, 10) }),
      });
      if (r.ok) {
        const j = await r.json();
        setSavedDays(j.retentionDays);
        setMessage({ kind: 'ok', text: `Retention set to ${j.retentionDays} days` });
      } else {
        const j = await r.json().catch(() => ({}));
        setMessage({ kind: 'err', text: j.error || `HTTP ${r.status}` });
      }
    } finally { setSaving(false); }
  };

  const pruneNow = async () => {
    setPruning(true);
    setMessage(null);
    try {
      const r = await authFetch('/api/admin/history-retention/prune', { method: 'POST' });
      if (r.ok) {
        const j = await r.json();
        setMessage({ kind: 'ok', text: `Pruned ${j.deleted} row(s) older than ${j.retentionDays} days` });
        load();
      } else {
        setMessage({ kind: 'err', text: `Prune failed (HTTP ${r.status})` });
      }
    } finally { setPruning(false); }
  };

  const dirty = String(savedDays) !== String(days);
  const valid = days !== '' && !isNaN(parseInt(days, 10)) && parseInt(days, 10) >= 0 && parseInt(days, 10) <= 3650;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5 mb-4">
      <h4 className="font-semibold text-gray-900 mb-1">Version History Retention</h4>
      <p className="text-sm text-gray-600 mb-4">
        How long row-level change history is kept in the audit log. Older entries are pruned automatically every 6 hours.
        Set to <code>0</code> to disable pruning and keep history forever.
      </p>

      <div className="flex items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Retention (days)</label>
          <input
            type="number"
            min="0"
            max="3650"
            value={days}
            onChange={e => setDays(e.target.value)}
            disabled={loading}
            className="w-32 px-3 py-1.5 text-sm border rounded"
          />
        </div>
        <button
          onClick={save}
          disabled={!dirty || !valid || saving || loading}
          className="px-4 py-1.5 text-sm font-medium rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-gray-300 disabled:text-gray-500"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={pruneNow}
          disabled={pruning || loading}
          className="px-4 py-1.5 text-sm font-medium rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
        >
          {pruning ? 'Pruning…' : 'Prune now'}
        </button>
        {totalRows != null && (
          <span className="ml-2 text-xs text-gray-500">{totalRows.toLocaleString()} history rows stored</span>
        )}
      </div>

      {message && (
        <div className={`mt-3 text-sm ${message.kind === 'ok' ? 'text-green-700' : 'text-red-700'}`}>
          {message.text}
        </div>
      )}
    </div>
  );
}

// ─── Danger Zone — Clean Database ─────────────────────────────────────────────
function DangerZoneSection({ onRefresh }) {
  const { authFetch } = useAuth();
  const [confirmStep, setConfirmStep] = useState(0); // 0=idle, 1=confirm, 2=type-confirm
  const [typedConfirm, setTypedConfirm] = useState('');
  const [cleaning, setCleaning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleClean = async () => {
    setCleaning(true);
    setError(null);
    try {
      const r = await authFetch('/api/admin/clean-database', { method: 'POST' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setResult(data);
      setConfirmStep(0);
      setTypedConfirm('');
      onRefresh?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setCleaning(false);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-red-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-red-100 bg-red-50">
        <div className="flex items-center gap-3">
          <span className="text-lg">⚠️</span>
          <span className="font-medium text-red-900">Danger Zone</span>
        </div>
      </div>
      <div className="p-5">
        <h4 className="font-semibold text-gray-900 mb-1">Clean Database</h4>
        <p className="text-sm text-gray-600 mb-4">
          Wipes all identity data (users, groups, assignments, identities, governance, sync log) but
          preserves crawler configurations, risk profiles, and correlation rules. Use this when you want
          to re-sync from a clean slate without re-creating your crawler setup.
        </p>

        {result && (
          <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded">
            <div className="font-medium text-green-800 text-sm mb-2">Database cleaned</div>
            <div className="text-xs text-green-700">
              Wiped {result.wiped?.length || 0} table{result.wiped?.length !== 1 ? 's' : ''}
              {result.skipped?.length > 0 && ` (${result.skipped.length} skipped)`}
            </div>
            {result.wiped?.length > 0 && (
              <details className="mt-2">
                <summary className="text-xs text-green-700 cursor-pointer hover:underline">Show details</summary>
                <ul className="mt-1 text-xs text-green-600 space-y-0.5">
                  {result.wiped.map(w => (
                    <li key={w.table}>
                      <code>{w.table}</code>: {w.rowsAffected} rows{w.temporal ? ' (temporal)' : ''}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <button onClick={() => setResult(null)} className="mt-2 text-xs text-green-600 hover:text-green-800">Dismiss</button>
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded">
            <div className="text-sm text-red-700">{error}</div>
            <button onClick={() => setError(null)} className="mt-1 text-xs text-red-600 hover:text-red-800">Dismiss</button>
          </div>
        )}

        {confirmStep === 0 && (
          <button
            onClick={() => setConfirmStep(1)}
            className="px-4 py-2 bg-red-600 text-white rounded text-sm font-medium hover:bg-red-700"
          >
            Clean Database
          </button>
        )}

        {confirmStep === 1 && (
          <div className="p-4 bg-yellow-50 border border-yellow-300 rounded">
            <p className="text-sm text-yellow-900 font-medium mb-2">Are you sure?</p>
            <p className="text-xs text-yellow-800 mb-3">
              This will delete all identity data. Crawler configurations and risk profiles will be kept.
              You'll need to re-run your crawlers to populate the data again.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmStep(2)}
                className="px-3 py-1.5 bg-red-600 text-white rounded text-sm hover:bg-red-700"
              >
                Yes, continue
              </button>
              <button
                onClick={() => setConfirmStep(0)}
                className="px-3 py-1.5 bg-gray-200 text-gray-700 rounded text-sm hover:bg-gray-300"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {confirmStep === 2 && (
          <div className="p-4 bg-red-50 border border-red-300 rounded">
            <p className="text-sm text-red-900 font-medium mb-2">Final confirmation</p>
            <p className="text-xs text-red-800 mb-3">
              Type <code className="px-1 bg-red-100 rounded">DELETE ALL DATA</code> to confirm:
            </p>
            <input
              type="text"
              value={typedConfirm}
              onChange={e => setTypedConfirm(e.target.value)}
              placeholder="DELETE ALL DATA"
              className="w-full p-2 border rounded mb-3 text-sm font-mono"
            />
            <div className="flex gap-2">
              <button
                onClick={handleClean}
                disabled={cleaning || typedConfirm !== 'DELETE ALL DATA'}
                className="px-3 py-1.5 bg-red-600 text-white rounded text-sm hover:bg-red-700 disabled:opacity-50"
              >
                {cleaning ? 'Cleaning...' : 'Clean Database'}
              </button>
              <button
                onClick={() => { setConfirmStep(0); setTypedConfirm(''); }}
                className="px-3 py-1.5 bg-gray-200 text-gray-700 rounded text-sm hover:bg-gray-300"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Admin Sub-Tabs ───────────────────────────────────────────────────────────
const ADMIN_TABS = [
  { key: 'crawlers',     label: 'Crawlers',            description: 'Add, configure and run identity data crawlers' },
  { key: 'data',         label: 'Data',                description: 'Export/import curated data and clean the database' },
  { key: 'correlation',  label: 'Account Correlation', description: 'Rules for linking accounts to identities' },
  { key: 'risk-scoring', label: 'Risk Scoring',        description: 'Risk profile, classifiers and feature toggle' },
  { key: 'llm',          label: 'LLM Settings',        description: 'Configure the LLM provider used by risk scoring and account correlation' },
  { key: 'performance',  label: 'Performance',         description: 'API and SQL performance metrics' },
  { key: 'containers',   label: 'Containers',          description: 'Live CPU, memory and network for the Docker stack' },
  { key: 'auth',         label: 'Authentication',      description: 'Configure Entra ID single sign-on' },
];

// ─── LLM Settings sub-tab ────────────────────────────────────────────────────
// Configures the LLM provider used by risk scoring, classifier generation and
// (future) account correlation. The API key never leaves the server — the GET
// returns `apiKeySet: true|false` and the form lets you re-type a new key when
// rotating. The Test button does a single ping with the live or unsaved config
// so the user can verify credentials before clicking Save.
function LLMSettingsSection() {
  const { authFetch } = useAuth();
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState([]);
  const [defaultModels, setDefaultModels] = useState({});
  const [config, setConfig] = useState({
    provider: 'anthropic',
    model: '',
    endpoint: '',
    deployment: '',
    apiVersion: '',
    apiKey: '',
  });
  const [apiKeySet, setApiKeySet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [message, setMessage] = useState(null);
  // Model discovery state. `models` is null until the user clicks "Refresh models"
  // (or until auto-discovery fires). `modelsLoading` gates the button.
  const [models, setModels] = useState(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await authFetch('/api/admin/llm/config');
      if (r.ok) {
        const j = await r.json();
        setProviders(j.providers || []);
        setDefaultModels(j.defaultModels || {});
        setApiKeySet(!!j.apiKeySet);
        if (j.config) {
          setConfig(c => ({
            ...c,
            provider:   j.config.provider   || 'anthropic',
            model:      j.config.model      || '',
            endpoint:   j.config.endpoint   || '',
            deployment: j.config.deployment || '',
            apiVersion: j.config.apiVersion || '',
            apiKey:     '', // never returned from server
          }));
        }
      }
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isAzure = config.provider === 'azure-openai';
  const placeholderModel = defaultModels[config.provider] || '';

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    setTestResult(null);
    try {
      const body = {
        provider:   config.provider,
        model:      config.model || null,
        endpoint:   isAzure ? (config.endpoint || null) : null,
        deployment: isAzure ? (config.deployment || null) : null,
        apiVersion: isAzure ? (config.apiVersion || null) : null,
      };
      if (config.apiKey) body.apiKey = config.apiKey;
      const r = await authFetch('/api/admin/llm/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (r.ok) {
        setMessage({ kind: 'ok', text: 'LLM settings saved' });
        setConfig(c => ({ ...c, apiKey: '' }));
        load();
      } else {
        setMessage({ kind: 'err', text: j.error || `HTTP ${r.status}` });
      }
    } finally { setSaving(false); }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setMessage(null);
    try {
      const body = {
        provider:   config.provider,
        model:      config.model || null,
        endpoint:   isAzure ? (config.endpoint || null) : null,
        deployment: isAzure ? (config.deployment || null) : null,
        apiVersion: isAzure ? (config.apiVersion || null) : null,
      };
      // If user has typed a key in the form, use it. Otherwise the server will use the saved one.
      if (config.apiKey) body.apiKey = config.apiKey;
      const r = await authFetch('/api/admin/llm/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      setTestResult(j);
    } finally { setTesting(false); }
  };

  const handleClear = async () => {
    if (!confirm('Clear the LLM configuration and stored API key?')) return;
    await authFetch('/api/admin/llm/config', { method: 'DELETE' });
    setConfig({ provider: 'anthropic', model: '', endpoint: '', deployment: '', apiVersion: '', apiKey: '' });
    setApiKeySet(false);
    setModels(null);
    setMessage({ kind: 'ok', text: 'LLM configuration cleared' });
  };

  // Fetch the list of models for the current provider. Uses the typed API key
  // if present, otherwise the server falls back to the saved vault key.
  const handleRefreshModels = async () => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const body = { provider: config.provider };
      if (config.apiKey)    body.apiKey    = config.apiKey;
      if (config.endpoint)  body.endpoint  = config.endpoint;
      if (config.apiVersion) body.apiVersion = config.apiVersion;
      const r = await authFetch('/api/admin/llm/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.ok) {
        setModels(j.models || []);
      } else {
        setModelsError(j.error || 'Failed to fetch models');
        setModels(null);
      }
    } catch (err) {
      setModelsError(err.message);
      setModels(null);
    } finally { setModelsLoading(false); }
  };

  // Reset the discovered model list whenever the provider changes — a model
  // list for Anthropic is not valid for OpenAI.
  useEffect(() => { setModels(null); setModelsError(null); }, [config.provider]);

  if (loading) return <div className="text-sm text-gray-500 p-6">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h3 className="text-base font-semibold text-gray-900 mb-1">LLM Provider</h3>
        <p className="text-sm text-gray-600 mb-4">
          Used by risk profiling, classifier generation and conversational refinement.
          The API key is encrypted at rest with envelope encryption — only the masked status is visible after saving.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Provider */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Provider</label>
            <select
              value={config.provider}
              onChange={e => setConfig(c => ({ ...c, provider: e.target.value }))}
              className="w-full px-3 py-1.5 text-sm border rounded"
            >
              {providers.map(p => (
                <option key={p} value={p}>{p === 'azure-openai' ? 'Azure OpenAI' : p === 'anthropic' ? 'Anthropic Claude' : 'OpenAI'}</option>
              ))}
            </select>
          </div>

          {/* Model — dropdown after discovery, otherwise free-text input */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-medium text-gray-700">
                {isAzure ? 'Deployment' : 'Model'}
              </label>
              <button
                type="button"
                onClick={handleRefreshModels}
                disabled={modelsLoading || (!config.apiKey && !apiKeySet)}
                className="text-xs text-indigo-600 hover:text-indigo-800 disabled:text-gray-400"
                title={(!config.apiKey && !apiKeySet) ? 'Enter an API key first' : 'Fetch available models from the provider'}
              >
                {modelsLoading ? 'Loading…' : models ? 'Refresh' : 'Discover models'}
              </button>
            </div>
            {models && models.length > 0 ? (
              <select
                value={config.model || ''}
                onChange={e => setConfig(c => ({ ...c, model: e.target.value }))}
                className="w-full px-3 py-1.5 text-sm border rounded font-mono"
              >
                <option value="">— select a model —</option>
                {models.map(m => (
                  <option key={m.id} value={m.id}>{m.label || m.id}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={config.model}
                onChange={e => setConfig(c => ({ ...c, model: e.target.value }))}
                placeholder={placeholderModel || (isAzure ? 'e.g. gpt-4o-prod' : '')}
                className="w-full px-3 py-1.5 text-sm border rounded font-mono"
              />
            )}
            {modelsError && (
              <div className="text-xs text-red-600 mt-1">Model discovery failed: {modelsError}</div>
            )}
            {models && models.length === 0 && (
              <div className="text-xs text-amber-600 mt-1">No models returned — check your API key permissions.</div>
            )}
          </div>

          {/* Azure-only fields */}
          {isAzure && (
            <>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">Azure endpoint</label>
                <input
                  type="text"
                  value={config.endpoint}
                  onChange={e => setConfig(c => ({ ...c, endpoint: e.target.value }))}
                  placeholder="https://my-resource.openai.azure.com"
                  className="w-full px-3 py-1.5 text-sm border rounded font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Deployment</label>
                <input
                  type="text"
                  value={config.deployment}
                  onChange={e => setConfig(c => ({ ...c, deployment: e.target.value }))}
                  placeholder="gpt-4o-prod"
                  className="w-full px-3 py-1.5 text-sm border rounded font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">API version</label>
                <input
                  type="text"
                  value={config.apiVersion}
                  onChange={e => setConfig(c => ({ ...c, apiVersion: e.target.value }))}
                  placeholder="2024-08-01-preview"
                  className="w-full px-3 py-1.5 text-sm border rounded font-mono"
                />
              </div>
            </>
          )}

          {/* API key */}
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-gray-700 mb-1">
              API key {apiKeySet && <span className="ml-2 text-green-600">• stored</span>}
            </label>
            <input
              type="password"
              value={config.apiKey}
              onChange={e => setConfig(c => ({ ...c, apiKey: e.target.value }))}
              placeholder={apiKeySet ? '••••••••  (leave blank to keep existing)' : 'sk-...'}
              autoComplete="new-password"
              className="w-full px-3 py-1.5 text-sm border rounded font-mono"
            />
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 text-sm font-medium rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-gray-300"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={handleTest}
            disabled={testing}
            className="px-4 py-1.5 text-sm font-medium rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {apiKeySet && (
            <button
              onClick={handleClear}
              className="px-4 py-1.5 text-sm font-medium rounded border border-red-300 text-red-700 hover:bg-red-50"
            >
              Clear
            </button>
          )}
        </div>

        {message && (
          <div className={`mt-3 text-sm ${message.kind === 'ok' ? 'text-green-700' : 'text-red-700'}`}>
            {message.text}
          </div>
        )}
        {testResult && (
          <div className={`mt-3 text-sm rounded border p-3 ${testResult.ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
            {testResult.ok ? (
              <>
                <div className="font-medium">Connection OK</div>
                <div className="text-xs mt-1">model: <code>{testResult.model}</code> · {testResult.latencyMs}ms</div>
                {testResult.sample && <div className="text-xs mt-1">sample: <code>{testResult.sample}</code></div>}
              </>
            ) : (
              <>
                <div className="font-medium">Connection failed</div>
                <div className="text-xs mt-1">{testResult.error}</div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── New-profile launcher (opens the wizard) ────────────────────────────────
function NewRiskProfileLauncher({ onRiskScoresRefresh }) {
  const [open, setOpen] = useState(false);
  const [bumpKey, setBumpKey] = useState(0);
  return (
    <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 flex items-center justify-between">
      <div>
        <div className="text-sm font-medium text-indigo-900">Create a new risk profile</div>
        <div className="text-xs text-indigo-700 mt-0.5">
          Walks you through generating an organisational profile and classifier set with the LLM, then optionally runs a scoring pass.
        </div>
      </div>
      <button onClick={() => setOpen(true)} className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700">
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
function RiskScoringSection({ onRiskScoresRefresh }) {
  const { authFetch } = useAuth();
  const [features, setFeatures] = useState(null);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState(null);

  const fetchFeatures = async () => {
    try {
      const r = await fetch('/api/features');
      if (r.ok) setFeatures(await r.json());
    } catch { /* ignore */ }
  };
  useEffect(() => { fetchFeatures(); }, []);

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

  const enabled = features?.riskScoring !== false;

  return (
    <div className="space-y-4">
      {/* Feature toggle card */}
      <div className={`rounded-lg border p-5 ${enabled ? 'bg-white border-gray-200' : 'bg-gray-50 border-gray-300'}`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Risk Scoring Feature</h3>
            <p className="text-sm text-gray-600 mt-1">
              Risk scoring assigns a 0-100 risk score to every identity based on direct classifier matches,
              membership analysis, structural hygiene checks, and cross-entity propagation.
              When disabled, the Risk Scores tab is hidden from the main navigation and the scoring engine
              is skipped during sync runs.
            </p>
            {error && (
              <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>
            )}
          </div>
          <div className="flex-shrink-0">
            <button
              onClick={handleToggle}
              disabled={toggling || features === null}
              className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                enabled ? 'bg-emerald-600' : 'bg-gray-300'
              } disabled:opacity-50`}
              title={enabled ? 'Disable risk scoring' : 'Enable risk scoring'}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                  enabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
            <div className="text-xs text-gray-500 text-center mt-1">
              {toggling ? '...' : enabled ? 'Enabled' : 'Disabled'}
            </div>
          </div>
        </div>
      </div>

      {/* Risk profile + classifiers — only render when feature is enabled */}
      {enabled ? (
        <>
          <NewRiskProfileLauncher onRiskScoresRefresh={onRiskScoresRefresh} />
          <RiskProfileSection />
          <ClassifiersSection />
        </>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-6 text-center text-sm text-gray-500">
          Risk Scoring is disabled. Enable the feature toggle above to configure profiles and classifiers.
        </div>
      )}
    </div>
  );
}

function AdminSubTabs({ activeTab, onTabChange }) {
  return (
    <div className="border-b border-gray-200 mb-4">
      <nav className="flex gap-1 -mb-px">
        {ADMIN_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => onTabChange(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-indigo-600 text-indigo-700'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

export default function AdminPage({ onNavigate, onRefresh, onRiskScoresRefresh }) {
  // Persist active sub-tab in URL hash like #admin?sub=crawlers so deep links work.
  // Also handles legacy #crawlers and #performance hashes by mapping them to the
  // corresponding sub-tab.
  const getInitialTab = () => {
    const hash = window.location.hash.replace('#', '');
    const page = hash.split('?')[0];
    if (page === 'crawlers') return 'crawlers';
    if (page === 'performance') return 'performance';
    // Parse query parameters properly using URLSearchParams (consistent with App.jsx parseHash())
    const qIndex = hash.indexOf('?');
    const params = new URLSearchParams(qIndex >= 0 ? hash.substring(qIndex + 1) : '');
    const sub = params.get('sub');
    return sub && ADMIN_TABS.some(t => t.key === sub) ? sub : 'crawlers';
  };
  const [activeTab, setActiveTab] = useState(getInitialTab);

  useEffect(() => {
    // Update the hash when the user changes sub-tab so reloads land in the same place.
    // Also rewrite legacy #crawlers / #performance to #admin?sub=...
    const hash = window.location.hash.replace('#', '');
    const page = hash.split('?')[0];
    const isLegacy = page === 'crawlers' || page === 'performance';
    const newHash = `#admin?sub=${activeTab}`;
    if (isLegacy || !window.location.hash.includes(`sub=${activeTab}`)) {
      window.history.replaceState(null, '', newHash);
    }
  }, [activeTab]);

  const currentTab = ADMIN_TABS.find(t => t.key === activeTab) || ADMIN_TABS[0];

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-3 px-2">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Admin</h2>
          <p className="text-sm text-gray-500 mt-0.5">{currentTab.description}</p>
        </div>
      </div>

      <AdminSubTabs activeTab={activeTab} onTabChange={setActiveTab} />

      <div className="space-y-4 px-2">
        {activeTab === 'crawlers' && (
          <Suspense fallback={<div className="text-sm text-gray-500 p-6">Loading…</div>}>
            <CrawlersPage onNavigate={onNavigate} />
          </Suspense>
        )}

        {activeTab === 'data' && (
          <>
            <PowerQueryExportSection />
            <CuratedDataSection />
            <HistoryRetentionSection />
            <DangerZoneSection onRefresh={onRefresh} />
          </>
        )}

        {activeTab === 'correlation' && <CorrelationSection />}
        {activeTab === 'risk-scoring' && <RiskScoringSection onRiskScoresRefresh={onRiskScoresRefresh} />}
        {activeTab === 'llm' && <LLMSettingsSection />}

        {activeTab === 'performance' && (
          <Suspense fallback={<div className="text-sm text-gray-500 p-6">Loading…</div>}>
            <PerfPage />
          </Suspense>
        )}

        {activeTab === 'containers' && (
          <Suspense fallback={<div className="text-sm text-gray-500 p-6">Loading…</div>}>
            <ContainerStatsPage />
          </Suspense>
        )}

        {activeTab === 'auth' && (
          <Suspense fallback={<div className="text-sm text-gray-500 p-6">Loading…</div>}>
            <AuthSettingsPage />
          </Suspense>
        )}
      </div>
    </div>
  );
}
