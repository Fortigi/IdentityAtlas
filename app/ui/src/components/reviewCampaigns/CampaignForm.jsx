import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { STEP_INFO } from '@ui/components/businessRoles/review/reviewSteps';
import { ALL_STEPS, INTERVALS, emptyForm, filterRoles, formBody, formProblem, rolesInScope, toggled } from './campaigns';

// ─── A new review campaign ───────────────────────────────────────────────
// What to review (the steps), which business roles (whole role portfolios, or
// roles one by one) and when (once, or again on a schedule). Who is asked is
// fixed for now: the Accountable of each role. A role with nobody Accountable
// can be in scope, but nobody is asked about it; the form says how many.

const CARD = 'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800';
const LABEL = 'mb-1 block text-sm font-medium text-gray-900 dark:text-gray-100';
const INPUT = 'rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100';
const MUTED = 'text-xs text-gray-600 dark:text-gray-400';
const lower = (v) => String(v ?? '').toLowerCase();

function Steps({ steps, onChange }) {
  return (
    <fieldset className={CARD}>
      <legend className="px-1 text-sm font-semibold text-gray-900 dark:text-gray-100">What to review</legend>
      <div className="space-y-1.5">
        {ALL_STEPS.map((step, i) => (
          <label key={step} className="flex items-start gap-2 text-sm text-gray-900 dark:text-gray-100">
            <input type="checkbox" checked={steps.includes(step)} onChange={() => onChange(toggled(steps, step))} className="mt-0.5 rounded" />
            <span><span className="font-medium">{i + 1}. {STEP_INFO[step].label}</span> <span className={MUTED}>{STEP_INFO[step].question}</span></span>
          </label>
        ))}
      </div>
      <p className={`${MUTED} mt-3`}>Asked of: the Accountable of each role.</p>
    </fieldset>
  );
}

function Scope({ form, options, onChange }) {
  const [search, setSearch] = useState('');
  const portfolios = new Set(form.portfolioIds.map(lower));
  const roles = filterRoles(options.roles, search);
  const scope = rolesInScope(form, options);
  return (
    <fieldset className={CARD}>
      <legend className="px-1 text-sm font-semibold text-gray-900 dark:text-gray-100">Which business roles</legend>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <p className={LABEL}>Whole role portfolios</p>
          <p className={`${MUTED} mb-2`}>Every role in the portfolio, also the ones added to it later.</p>
          {options.portfolios.length === 0 ? <p className={MUTED}>There are no role portfolios.</p> : (
            <ul aria-label="Role portfolios" className="max-h-64 space-y-1 overflow-auto">
              {options.portfolios.map(p => (
                <li key={p.id}>
                  <label className="flex items-center gap-2 text-sm text-gray-900 dark:text-gray-100">
                    <input type="checkbox" checked={portfolios.has(lower(p.id))} onChange={() => onChange({ portfolioIds: toggled(form.portfolioIds, p.id) })} className="rounded" />
                    <span>{p.displayName}</span>
                    <span className={MUTED}>{p.roleCount} {p.roleCount === 1 ? 'role' : 'roles'}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <label className={LABEL} htmlFor="campaign-role-search">Business roles one by one</label>
          <input id="campaign-role-search" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by role or portfolio…" className={`${INPUT} mb-2 w-full`} />
          {roles.length === 0 ? <p className={MUTED}>No business role matches.</p> : (
            <ul aria-label="Business roles" className="max-h-64 space-y-1 overflow-auto">
              {roles.map((r) => {
                const viaPortfolio = !!r.portfolioId && portfolios.has(lower(r.portfolioId));
                return (
                  <li key={r.id}>
                    <label className="flex items-center gap-2 text-sm text-gray-900 dark:text-gray-100">
                      <input type="checkbox" checked={viaPortfolio || form.roleIds.includes(r.id)} disabled={viaPortfolio}
                        onChange={() => onChange({ roleIds: toggled(form.roleIds, r.id) })} className="rounded" />
                      <span>{r.displayName}</span>
                      {r.portfolioName && <span className={MUTED}>{r.portfolioName}</span>}
                      {!r.hasAccountable && <span className="rounded border border-red-200 bg-red-50 px-1.5 text-[11px] font-medium text-red-800 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300">No Accountable</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      <p className="mt-3 text-sm text-gray-800 dark:text-gray-200" data-testid="scope-summary">
        {scope.roles.length} {scope.roles.length === 1 ? 'business role' : 'business roles'} in scope now.{' '}
        {scope.withoutAccountable.length > 0 && (
          <span className="font-medium text-red-800 dark:text-red-300">
            {scope.withoutAccountable.length} {scope.withoutAccountable.length === 1 ? 'has' : 'have'} nobody Accountable and {scope.withoutAccountable.length === 1 ? 'falls' : 'fall'} outside the campaign: nobody is asked.
          </span>
        )}
      </p>
    </fieldset>
  );
}

function Schedule({ form, onChange }) {
  return (
    <fieldset className={CARD}>
      <legend className="px-1 text-sm font-semibold text-gray-900 dark:text-gray-100">When</legend>
      <div className="flex flex-wrap items-end gap-4">
        <div role="radiogroup" aria-label="How often" className="space-y-1">
          <label className="flex items-center gap-2 text-sm text-gray-900 dark:text-gray-100">
            <input type="radio" name="campaign-repeat" checked={!form.repeat} onChange={() => onChange({ repeat: false })} /> Once
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-900 dark:text-gray-100">
            <input type="radio" name="campaign-repeat" checked={form.repeat} onChange={() => onChange({ repeat: true })} /> On a schedule
          </label>
        </div>
        {form.repeat && (
          <label>
            <span className={LABEL}>Repeat</span>
            <select value={form.intervalMonths} onChange={e => onChange({ intervalMonths: Number(e.target.value) })} className={INPUT}>
              {INTERVALS.map(i => <option key={i.months} value={i.months}>{i.label}</option>)}
            </select>
          </label>
        )}
        <label>
          <span className={LABEL}>{form.repeat ? 'First round starts on' : 'Starts on'}</span>
          <input type="date" value={form.startsOn} onChange={e => onChange({ startsOn: e.target.value })} className={INPUT} />
        </label>
        <label>
          <span className={LABEL}>Days to do the review</span>
          <input type="number" min={1} max={365} value={form.dueDays} onChange={e => onChange({ dueDays: e.target.value })} className={`${INPUT} w-24`} />
        </label>
      </div>
    </fieldset>
  );
}

export default function CampaignForm({ onSaved, onCancel }) {
  const { authFetch } = useAuth();
  const options = useFetch('/api/review-campaigns/scope-options', { authFetch });
  const [form, setForm] = useState(() => emptyForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const change = (patch) => setForm(prev => ({ ...prev, ...patch }));
  const problem = formProblem(form);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch('/api/review-campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formBody(form)) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { setError(body.error || `Could not save the campaign (HTTP ${r.status})`); return; }
      onSaved(body);
    } catch (err) {
      setError(err.message || 'Could not save the campaign');
    } finally {
      setBusy(false);
    }
  }

  if (options.loading && !options.data) return <p className={MUTED}>Loading the business roles…</p>;
  if (options.error) return <p role="alert" className="text-sm text-red-700 dark:text-red-400">The business roles could not be loaded: {options.error.message}</p>;
  const choices = { roles: options.data?.roles ?? [], portfolios: options.data?.portfolios ?? [] };

  return (
    <form onSubmit={save} aria-label="New review campaign" className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">New review campaign</h3>
        <button type="button" onClick={onCancel} disabled={busy} className="text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200">Cancel</button>
      </div>
      <label className="block">
        <span className={LABEL}>Name</span>
        <input value={form.name} onChange={e => change({ name: e.target.value })} maxLength={200} placeholder="Yearly review of the finance roles" className={`${INPUT} w-full max-w-xl`} />
      </label>
      <Steps steps={form.steps} onChange={steps => change({ steps })} />
      <Scope form={form} options={choices} onChange={change} />
      <Schedule form={form} onChange={change} />
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={!!problem || busy}
          className="rounded bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50">
          {busy ? 'Saving…' : 'Start the campaign'}
        </button>
        {problem && <span className="text-xs text-amber-800 dark:text-amber-300">{problem}</span>}
      </div>
    </form>
  );
}
