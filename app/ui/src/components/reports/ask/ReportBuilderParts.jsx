// PROTOTYPE — the sections of the report builder tab (ReportBuilderPage).
//
// Presentational only: the page owns the draft, the preview run and save/delete.

import ListReportRenderer from '@ui/components/reports/ListReportRenderer';
import SpecEditor from './SpecEditor';
import ConfirmChoices from './ConfirmChoices';

export const CARD = 'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800';
const PRIMARY = 'rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600';
const SECONDARY = 'rounded bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600';
const DANGER = 'rounded border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/20';
const INPUT = 'w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100';
export const H3 = 'mb-2 text-sm font-semibold text-gray-900 dark:text-white';

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

export function BuilderHeader({ isNew, name, message, saving, onOpenReport, onDelete, onSave }) {
  return (
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
          <button type="button" className={SECONDARY} onClick={onOpenReport}>Open report</button>
        )}
        {!isNew && <button type="button" className={DANGER} onClick={onDelete}>Delete</button>}
        <button type="button" className={PRIMARY} disabled={saving || !name.trim()} onClick={onSave}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

export function ReportDetailsForm({ name, description, onNameChange, onDescriptionChange }) {
  return (
    <div className={`${CARD} grid gap-3 md:grid-cols-2`}>
      <div>
        <label htmlFor="report-name" className="mb-1 block text-sm font-medium text-gray-800 dark:text-gray-200">Name</label>
        <input id="report-name" className={INPUT} value={name} onChange={e => onNameChange(e.target.value)} placeholder="e.g. Guests without an active manager" />
      </div>
      <div>
        <label htmlFor="report-description" className="mb-1 block text-sm font-medium text-gray-800 dark:text-gray-200">Description</label>
        <input id="report-description" className={INPUT} value={description} onChange={e => onDescriptionChange(e.target.value)} placeholder="Optional — shown in the Reports list" />
      </div>
    </div>
  );
}

function previewLabel(running, result, dirty) {
  if (running) return 'Running…';
  return result && !dirty ? 'Refresh preview' : 'Preview';
}

export function DefinitionPanel({ spec, catalog, dirty, result, running, onEdit, onRun }) {
  return (
    <div className={`${CARD} grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]`}>
      <div>
        <h3 className={H3}>Report definition</h3>
        <SpecEditor spec={spec} catalog={catalog} onChange={onEdit} />
        <div className="mt-3 flex items-center gap-2">
          <button type="button" className={PRIMARY} disabled={running} onClick={onRun}>
            {previewLabel(running, result, dirty)}
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
  );
}

export function PreviewResults({ name, confirm, running, runError, result, onChoose, onOpenDetail }) {
  return (
    <>
      {confirm && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-gray-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-gray-100">
          <ConfirmChoices confirm={confirm.confirm} busy={running} onChoose={onChoose} />
        </div>
      )}
      {runError && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{runError}</p>}
      {result && (
        <div className="space-y-2">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            Preview: {result.total} row{result.total === 1 ? '' : 's'}{result.truncated ? ' (first rows only)' : ''}
          </p>
          <ListReportRenderer report={{ displayName: name || 'This report', columns: result.columns, rows: result.rows }} onOpenDetail={onOpenDetail} />
        </div>
      )}
    </>
  );
}
