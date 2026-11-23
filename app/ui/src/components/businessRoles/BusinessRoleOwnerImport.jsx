import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { Modal, ErrorBox, PrimaryButton, SecondaryButton } from '@ui/components/contexts/ModalPrimitives';

// Set the owners of many business roles from one list: choose a file, see what
// would change, then apply. Nothing is written before Apply.

const OWNER_TEMPLATE = 'Business role;Accountable;Responsible\nExample role;anna@example.com;bram@example.com | carla@example.com\n';

const ACTION_TEXT = {
  set: 'will be set', replace: 'will replace the current one', add: 'will be added', same: 'already set',
  kept: 'kept: someone chose another person by hand', unmatched: 'no account found', tooMany: 'only one Accountable per role',
};
const PROBLEM = new Set(['unmatched', 'tooMany']);

async function post(authFetch, step, file) {
  const form = new FormData();
  form.append('file', file);
  const r = await authFetch(`/api/business-roles/owners/import/${step}`, { method: 'POST', body: form });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

function downloadTemplate() {
  const url = URL.createObjectURL(new Blob([OWNER_TEMPLATE], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'business-role-owners.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function PlanRow({ row }) {
  if (row.problem) {
    return <li className="py-1 text-red-700 dark:text-red-400">Line {row.line}: {row.businessRole || '(empty)'}: {row.problem}</li>;
  }
  return (
    <li className="py-1 text-gray-800 dark:text-gray-200">
      <span className="font-medium">{row.businessRoleName}</span>
      <ul className="ml-3">
        {row.changes.map(c => (
          <li key={`${c.role}|${c.value}`} className={PROBLEM.has(c.action) ? 'text-red-700 dark:text-red-400' : 'text-gray-700 dark:text-gray-300'}>
            {c.role}: {c.displayName || c.value}, {ACTION_TEXT[c.action]}
          </li>
        ))}
      </ul>
    </li>
  );
}

function Preview({ plan }) {
  const { summary, rows, nearMatches = [] } = plan;
  return (
    <div className="space-y-2" data-testid="owner-import-preview">
      <p className="text-gray-800 dark:text-gray-200">
        {summary.toWrite} to write across {summary.roles} roles, {summary.unchanged} unchanged, {summary.kept} kept, {summary.problems} with a problem.
      </p>
      {nearMatches.length > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          <p className="font-medium">Matched on a similar name, please check:</p>
          <ul>{nearMatches.map(n => <li key={n.value}>{n.value} → {n.matched}</li>)}</ul>
        </div>
      )}
      <ul className="max-h-64 divide-y divide-gray-100 overflow-auto rounded border border-gray-200 px-2 dark:divide-gray-700/50 dark:border-gray-700">
        {rows.map(row => <PlanRow key={row.line} row={row} />)}
      </ul>
    </div>
  );
}

export default function BusinessRoleOwnerImport({ onClose }) {
  const { authFetch } = useAuth();
  const [file, setFile] = useState(null);
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function run(step, done) {
    setBusy(true);
    setError(null);
    try {
      done(await post(authFetch, step, file));
    } catch (e) {
      setError(e.message || 'The list could not be read');
    } finally {
      setBusy(false);
    }
  }

  function choose(e) {
    setFile(e.target.files?.[0] ?? null);
    setPlan(null);
    setResult(null);
    setError(null);
  }

  return (
    <Modal title="Import business role owners" subtitle="A CSV or Excel list with the columns Business role, Accountable and Responsible." onClose={onClose} width={560} dismissOnBackdrop={false}>
      <div className="space-y-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <input type="file" accept=".csv,.txt,.xlsx" aria-label="Owner list" onChange={choose} className="text-gray-700 dark:text-gray-300" />
          <button type="button" onClick={downloadTemplate} className="text-blue-700 underline hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200">Download template</button>
        </div>
        <p className="text-gray-600 dark:text-gray-400">Name people by e-mail, employee id or display name. Separate several with ; or |.</p>
        {plan && !result && <Preview plan={plan} />}
        {result && (
          <p role="status" className="text-gray-800 dark:text-gray-200">
            {result.written} owners written{result.kept ? `, ${result.kept} kept` : ''}.
          </p>
        )}
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2 pt-1">
          <SecondaryButton onClick={onClose} disabled={busy}>{result ? 'Close' : 'Cancel'}</SecondaryButton>
          {!result && !plan && <PrimaryButton onClick={() => run('preview', setPlan)} disabled={!file || busy}>Preview</PrimaryButton>}
          {!result && plan && <PrimaryButton onClick={() => run('apply', setResult)} disabled={busy || plan.summary.toWrite === 0}>Apply</PrimaryButton>}
        </div>
      </div>
    </Modal>
  );
}
