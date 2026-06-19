// Admin → Account Linking.
//
// Deterministic, no-LLM replacement for the old correlation wizard. Lets an
// admin review/edit the linking dictionary (signals + account-type patterns +
// threshold), set a schedule, run linking on demand, and see run history.
// Account linking attaches orphan accounts (admin / guest / secondary) to the
// Identity they belong to, and emits the "Orphaned Accounts" context for the
// rest.

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import ScheduleEditor from './ScheduleEditor';

function fmt(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString(); } catch { return String(d); }
}

const STATUS_STYLES = {
  completed: 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300',
  running:   'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300',
  pending:   'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300',
  failed:    'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300',
};

export default function AccountLinkingSettings() {
  const { authFetch } = useAuth();
  const [config, setConfig] = useState(null);
  const [rulesText, setRulesText] = useState('');
  const [schedules, setSchedules] = useState([]);
  const [isActive, setIsActive] = useState(true);
  const [threshold, setThreshold] = useState(50);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [runs, setRuns] = useState([]);
  const pollRef = useRef(null);

  const loadConfig = useCallback(() => {
    setLoading(true);
    authFetch('/api/account-linking/config')
      .then(r => r.json())
      .then(d => {
        setConfig(d);
        setRulesText(JSON.stringify(d.rules ?? {}, null, 2));
        setSchedules(Array.isArray(d.schedules) ? d.schedules : []);
        setIsActive(d.isActive !== false);
        setThreshold(Number(d.rules?.linkThreshold ?? 50));
      })
      .catch(() => setError('Failed to load configuration.'))
      .finally(() => setLoading(false));
  }, [authFetch]);

  const loadRuns = useCallback(() => {
    authFetch('/api/account-linking/runs')
      .then(r => r.json())
      .then(d => setRuns(d.data || []))
      .catch(() => {});
  }, [authFetch]);

  useEffect(() => { loadConfig(); loadRuns(); }, [loadConfig, loadRuns]);
  useEffect(() => () => clearInterval(pollRef.current), []);

  const save = async () => {
    setError(null); setNotice(null);
    let rules;
    try {
      rules = JSON.parse(rulesText);
    } catch (e) {
      setError(`Rules is not valid JSON: ${e.message}`);
      return;
    }
    rules.linkThreshold = threshold; // the slider is authoritative for the threshold
    setSaving(true);
    try {
      const r = await authFetch('/api/account-linking/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules, schedules, isActive }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setNotice('Saved.');
      loadConfig();
    } catch (e) {
      setError(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const pollRun = (id) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const r = await authFetch(`/api/account-linking/runs/${id}`);
        const run = await r.json();
        setRuns(prev => [run, ...prev.filter(x => x.id !== run.id)]);
        if (run.status === 'completed' || run.status === 'failed') {
          clearInterval(pollRef.current);
          setRunning(false);
          loadRuns();
        }
      } catch { /* keep polling */ }
    }, 1500);
  };

  const runNow = async () => {
    setError(null); setNotice(null); setRunning(true);
    try {
      const r = await authFetch('/api/account-linking/runs', { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const run = await r.json();
      setRuns(prev => [run, ...prev]);
      pollRun(run.id);
    } catch (e) {
      setError(`Could not start run: ${e.message}`);
      setRunning(false);
    }
  };

  const addSchedule = () => setSchedules(s => [...s, { enabled: true, frequency: 'daily', hour: 3, minute: 0 }]);
  const updateSchedule = (i, next) => setSchedules(s => s.map((x, idx) => (idx === i ? next : x)));
  const removeSchedule = (i) => setSchedules(s => s.filter((_, idx) => idx !== i));

  if (loading) return <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">Loading…</p>;

  let rulesObj = {};
  try { rulesObj = JSON.parse(rulesText); } catch { /* shown on save */ }
  const signalCount = (rulesObj.signals || []).length;
  const typeRuleCount = (rulesObj.accountTypeRules || []).length;

  return (
    <div className="mt-4 space-y-4">
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded-lg p-4">
        <div className="text-sm font-medium text-blue-900 dark:text-blue-200">Account Linking</div>
        <div className="text-xs text-blue-700 dark:text-blue-300 mt-0.5">
          Finds orphan accounts (admin, guest, secondary) that belong to an existing identity and links them with a
          confidence score. Deterministic — no LLM. Accounts that can't be linked are grouped into the
          <span className="font-medium"> Orphaned Accounts</span> context.
        </div>
      </div>

      {error && <div className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded p-3">{error}</div>}
      {notice && <div className="text-sm text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 rounded p-3">{notice}</div>}

      {/* Run controls */}
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={runNow} disabled={running}
          className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
          {running ? 'Running…' : 'Run now'}
        </button>
        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300">
          {signalCount} signal{signalCount !== 1 ? 's' : ''}
        </span>
        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300">
          {typeRuleCount} account-type rule{typeRuleCount !== 1 ? 's' : ''}
        </span>
        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300">
          threshold {threshold}%
        </span>
        {config?.defaults && (
          <span className="text-xs text-gray-600 dark:text-gray-400">(showing shipped defaults — save to persist)</span>
        )}
      </div>

      {/* Certainty threshold slider */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Auto-link certainty</h3>
          <span className="text-sm font-mono text-gray-700 dark:text-gray-300">&ge; {threshold}%</span>
        </div>
        <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
          Minimum confidence to link an account to an identity. Lower links more (incl. fuzzy name-only matches at ~60%);
          higher requires stronger evidence. Weaker links still show their score on the identity for analyst review.
        </p>
        <input
          type="range" min="0" max="100" step="5" value={threshold}
          onChange={e => setThreshold(Number(e.target.value))}
          className="w-full accent-blue-600"
        />
        <div className="flex justify-between text-[10px] text-gray-600 dark:text-gray-400 mt-1">
          <span>0 · link freely</span><span>~60 · name match</span><span>90 · near-certain</span>
        </div>
        <p className="text-[11px] text-gray-600 dark:text-gray-400 mt-1">Saved with the rules below.</p>
      </div>

      {/* Schedule */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Schedule</h3>
          <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
            <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
            Active
          </label>
        </div>
        {schedules.length === 0 && <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">No schedule — linking runs only when triggered manually or after a crawl.</p>}
        {schedules.map((s, i) => (
          <ScheduleEditor key={i} schedule={s} onChange={next => updateSchedule(i, next)} onRemove={() => removeSchedule(i)} />
        ))}
        <button onClick={addSchedule} className="text-xs px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
          + Add schedule
        </button>
      </div>

      {/* Rules editor */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-1">Linking rules (dictionary)</h3>
        <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
          Signals (weighted match rules), account-type patterns, <code>linkThreshold</code>, and
          <code> onlyLinkTypes</code>. Edit and Save to apply to the next run.
        </p>
        <textarea
          value={rulesText}
          onChange={e => setRulesText(e.target.value)}
          spellCheck={false}
          rows={18}
          className="w-full font-mono text-xs p-3 border border-gray-200 dark:border-gray-600 rounded bg-gray-50 dark:bg-gray-900 dark:text-gray-200"
        />
        <div className="flex items-center gap-2 mt-2">
          <button onClick={save} disabled={saving}
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={loadConfig} className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
            Reset
          </button>
        </div>
      </div>

      {/* Run history */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">Recent runs</h3>
        {runs.length === 0 ? (
          <p className="text-xs text-gray-600 dark:text-gray-400">No runs yet.</p>
        ) : (
          <div className="overflow-x-auto rounded border border-gray-200 dark:border-gray-700">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-700/50 text-left text-gray-600 dark:text-gray-300 uppercase tracking-wide">
                  <th className="px-3 py-2 font-semibold">Started</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">Step</th>
                  <th className="px-3 py-2 font-semibold">Linked</th>
                  <th className="px-3 py-2 font-semibold">Updated</th>
                  <th className="px-3 py-2 font-semibold">Skipped</th>
                  <th className="px-3 py-2 font-semibold">Orphans left</th>
                  <th className="px-3 py-2 font-semibold">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {runs.slice(0, 15).map(run => (
                  <tr key={run.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                    <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{fmt(run.startedAt)}</td>
                    <td className="px-3 py-2">
                      <span className={`px-1.5 py-0.5 rounded font-medium ${STATUS_STYLES[run.status] || 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'}`}>
                        {run.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{run.step || '—'}{run.status === 'running' ? ` (${run.pct}%)` : ''}</td>
                    <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{run.linksCreated ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{run.linksUpdated ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{run.skippedAnalystOverride ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{run.orphansRemaining ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{run.triggeredBy || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
