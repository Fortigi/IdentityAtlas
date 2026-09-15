// PROTOTYPE — create or edit a custom report, in its own tab (#report-builder:<id>).
//
// id "new-…" starts an empty report; any other id is a saved report being edited.
// A report can be built two ways, freely mixed: describe it to the local model
// (AskAssistant), or build/adjust the definition by hand (SpecEditor). The
// preview always shows what will actually run. Saving stores the definition;
// saved reports appear in the Reports list and open in the normal report tab.

import { useEffect, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useDialog } from '@ui/components/dialogContext';
import ListReportRenderer from '@ui/components/reports/ListReportRenderer';
import ReportError from '@ui/components/reports/ReportError';
import SpecEditor from './SpecEditor';
import AskAssistant, { postJson } from './AskAssistant';

const CARD = 'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800';
const PRIMARY = 'rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600';
const SECONDARY = 'rounded bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600';
const DANGER = 'rounded border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/20';
const INPUT = 'w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100';
const H3 = 'mb-2 text-sm font-semibold text-gray-900 dark:text-white';

function blankSpec(catalog, entity = 'user') {
  return { entity, match: 'all', conditions: [], columns: [...catalog.entities[entity].defaultColumns] };
}

function Interpretation({ explanation }) {
  if (!explanation) return null;
  return (
    <div className="text-sm text-gray-800 dark:text-gray-200">
      <p className="font-medium">{explanation.title}</p>
      <ul className="mt-1 space-y-0.5">
        {explanation.lines.map((l, i) => (
          <li key={i} style={{ paddingLeft: `${(l.depth + 1) * 1.25}rem` }}>• {l.text}</li>
        ))}
      </ul>
    </div>
  );
}

export default function ReportBuilderPage({ builderId, onClose, onOpenDetail, onCacheData }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const isNew = builderId.startsWith('new-');

  const { data: catalog, error: catalogError } = useFetch('/api/nl-reports/catalog', { authFetch });
  const { data: saved, error: savedError } = useFetch(isNew ? null : `/api/nl-reports/saved/${encodeURIComponent(builderId)}`, { authFetch, enabled: !isNew });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [question, setQuestion] = useState('');
  const [spec, setSpec] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [seeded, setSeeded] = useState(null);

  // Seed the form once from the saved report (render-time, not in an effect).
  if (saved && saved !== seeded) {
    setSeeded(saved);
    setName(saved.name);
    setDescription(saved.description || '');
    setQuestion(saved.question || '');
    setSpec(saved.definition);
  }
  // Start a new report with an editable, empty definition.
  if (isNew && catalog && !spec && seeded !== 'blank') {
    setSeeded('blank');
    setSpec(blankSpec(catalog));
  }

  const tabLabel = saved?.name;
  useEffect(() => {
    if (tabLabel) onCacheData?.(builderId, 'report-builder', { displayName: tabLabel });
  }, [tabLabel, builderId, onCacheData]);

  const run = async (s) => {
    setRunning(true);
    setRunError(null);
    try {
      const r = await postJson(authFetch, '/api/nl-reports/run', { spec: s });
      setResult(r);
      setSpec(r.spec);
      setDirty(false);
    } catch (e) {
      setRunError(e.message);
    } finally {
      setRunning(false);
    }
  };

  // Preview a saved report as soon as it is loaded.
  const savedDefinition = saved?.definition;
  useEffect(() => {
    if (savedDefinition) run(savedDefinition);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedDefinition]);

  const onReport = (reply, asked) => {
    setSpec(reply.spec);
    if (!question) setQuestion(asked);
    if (!name) setName(asked.length > 80 ? `${asked.slice(0, 77)}…` : asked);
    run(reply.spec);
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const body = { name, description, question, definition: spec };
      if (isNew) {
        const row = await postJson(authFetch, '/api/nl-reports/saved', body);
        // Swap this "new" tab for the saved report's own tab, so the URL can be
        // reopened. Open first: closing the active tab would navigate away.
        onOpenDetail?.('report-builder', row.id, row.name);
        onClose?.();
        return;
      }
      await postJson(authFetch, `/api/nl-reports/saved/${encodeURIComponent(builderId)}`, body, 'PUT');
      onCacheData?.(builderId, 'report-builder', { displayName: name });
      setMessage({ kind: 'ok', text: 'Saved' });
    } catch (e) {
      setMessage({ kind: 'err', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!(await dialog.confirm({ message: `Delete the report "${name}"? This cannot be undone.`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await postJson(authFetch, `/api/nl-reports/saved/${encodeURIComponent(builderId)}`, null, 'DELETE');
      onClose?.();
    } catch (e) {
      setMessage({ kind: 'err', text: e.message });
    }
  };

  if (catalogError || savedError) {
    return <ReportError title="Cannot open the report builder" message={(catalogError || savedError).message} onClose={onClose} />;
  }
  if (!catalog || !spec) {
    return <div className="flex h-64 items-center justify-center text-gray-500 dark:text-gray-400">Loading…</div>;
  }

  return (
    <section className="mx-auto max-w-6xl space-y-4" aria-labelledby="builder-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 id="builder-heading" className="text-lg font-semibold text-gray-900 dark:text-white">
          {isNew ? 'New report' : 'Edit report'}
          <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 align-middle text-xs font-medium text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">prototype</span>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {message && (
            <span role="status" className={message.kind === 'ok' ? 'text-sm text-green-700 dark:text-green-300' : 'text-sm text-red-700 dark:text-red-300'}>{message.text}</span>
          )}
          {!isNew && (
            <button type="button" className={SECONDARY} onClick={() => onOpenDetail?.('report', `custom-${builderId}`, name)}>Open report</button>
          )}
          {!isNew && <button type="button" className={DANGER} onClick={remove}>Delete</button>}
          <button type="button" className={PRIMARY} disabled={saving || !name.trim()} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>

      <div className={`${CARD} grid gap-3 md:grid-cols-2`}>
        <div>
          <label htmlFor="report-name" className="mb-1 block text-sm font-medium text-gray-800 dark:text-gray-200">Name</label>
          <input id="report-name" className={INPUT} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Guests without an active manager" />
        </div>
        <div>
          <label htmlFor="report-description" className="mb-1 block text-sm font-medium text-gray-800 dark:text-gray-200">Description</label>
          <input id="report-description" className={INPUT} value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional — shown in the Reports list" />
        </div>
      </div>

      <div className={CARD}>
        <h3 className={H3}>Describe it <span className="font-normal text-gray-600 dark:text-gray-400">— optional, uses the local model</span></h3>
        <AskAssistant currentSpec={isNew && !result ? null : spec} onReport={onReport} />
      </div>

      <div className={`${CARD} grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]`}>
        <div>
          <h3 className={H3}>Report definition</h3>
          <SpecEditor spec={spec} catalog={catalog} onChange={s => { setSpec(s); setDirty(true); }} />
          <div className="mt-3 flex items-center gap-2">
            <button type="button" className={PRIMARY} disabled={running} onClick={() => run(spec)}>
              {running ? 'Running…' : result && !dirty ? 'Refresh preview' : 'Preview'}
            </button>
            {dirty && result && <span className="text-xs text-gray-600 dark:text-gray-400">edited — preview is out of date</span>}
          </div>
        </div>
        <div className="space-y-3">
          <h3 className={H3}>What will run</h3>
          {result ? <Interpretation explanation={result.explanation} /> : <p className="text-sm text-gray-600 dark:text-gray-400">Preview the report to see how it reads.</p>}
          {result && (
            <details className="text-sm">
              <summary className="cursor-pointer text-gray-700 dark:text-gray-300">SQL ({result.elapsedMs} ms)</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-gray-50 p-2 text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-200">{result.sql}{`\n\n-- params: ${JSON.stringify(result.params)}`}</pre>
            </details>
          )}
        </div>
      </div>

      {runError && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{runError}</p>}
      {result && (
        <div className="space-y-2">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            Preview: {result.total} row{result.total === 1 ? '' : 's'}{result.truncated ? ' (first rows only)' : ''}
          </p>
          <ListReportRenderer report={{ displayName: name || 'This report', columns: result.columns, rows: result.rows }} onOpenDetail={onOpenDetail} />
        </div>
      )}
    </section>
  );
}
