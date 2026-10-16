// "Save as view" — a report's parameters, step by step, saved under a name.
//
// A view is shared across the deployment and listed on the Reports page as a
// report of its own (see app/api/src/reports/views.js). The wizard walks the
// report's parameters in the steps the report declares (`x-step`), so the
// Entitlement Pivot asks for its contexts, then its columns, then its Excel pivots,
// then a name. Report-agnostic: the steps, fields and pickers all come from the
// report's parametersSchema.
//
// Opened with the values on the tab, so "set it up, look at it, then save it"
// keeps what was set up.

import { useMemo, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import WizardShell from '@ui/components/WizardShell';
import SchemaConfigForm from '@ui/components/SchemaConfigForm';
import { sendJson, isNameClash } from '@ui/components/matrix/matrixRequests';
import { missingRequired, stepSchema, viewRequest, viewSteps } from './reportViewSteps';

const INPUT = 'mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100';
const PRIMARY = 'rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600';
const SECONDARY = 'rounded bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600';

export default function ReportViewWizard({ report, initialParams, onSaved, onCancel }) {
  const { authFetch } = useAuth();
  const schema = report.parametersSchema;
  const steps = useMemo(() => viewSteps(schema), [schema]);
  const editing = Boolean(report.view);

  const [current, setCurrent] = useState(1);
  const [params, setParams] = useState(initialParams || {});
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Editing starts from what is stored: the tab only knows the view's name and
  // a description that may be the report's own.
  const { data: stored } = useFetch(editing ? `/api/report-views/${encodeURIComponent(report.view.id)}` : null, { authFetch });
  const name = draft?.name ?? stored?.name ?? (editing ? report.displayName : '');
  const description = draft?.description ?? stored?.description ?? '';
  const setField = (field, value) => setDraft({ name, description, [field]: value });

  const step = steps.find(s => s.n === current);
  const blocked = missingRequired(schema, step.keys, params);
  const isLast = current === steps.length;

  async function save(asNew) {
    setSaving(true);
    setError(null);
    const request = viewRequest(report, { name: name.trim(), description: description.trim(), params }, { asNew });
    try {
      const saved = await sendJson(authFetch, request.url, { method: request.method, body: request.body, fallback: 'Failed to save the view' });
      onSaved?.(saved, { created: request.method === 'POST' });
    } catch (err) {
      setError(isNameClash(err) ? `There is already a view called "${name.trim()}". Pick another name.` : err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <WizardShell
      title={editing ? `Edit view "${report.displayName}"` : `Save "${report.displayName}" as a view`}
      onCancel={onCancel}
      steps={steps.map(({ n, label }) => ({ n, label }))}
      currentStep={current}
      onStepClick={setCurrent}
      allowAllSteps={editing}
      error={error}
    >
      {step.keys.length > 0 ? (
        <SchemaConfigForm schema={stepSchema(schema, step.keys)} params={params} onChange={setParams}
          idPrefix={`view-${report.name}`} />
      ) : (
        <NameStep name={name} description={description} onChange={setField} />
      )}

      {blocked.length > 0 && (
        <p role="status" className="mt-3 text-sm text-amber-700 dark:text-amber-300">
          Fill in {blocked.map(key => schema.properties[key]?.title || key).join(', ')} to continue.
        </p>
      )}

      <WizardButtons
        current={current} isLast={isLast} editing={editing} blocked={blocked.length > 0}
        canSave={!saving && Boolean(name.trim())} saving={saving} onStep={setCurrent} onSave={save}
      />
    </WizardShell>
  );
}

// The last step: what the view is called, and what it is for.
function NameStep({ name, description, onChange }) {
  return (
    <div className="max-w-xl space-y-3">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        A view is shared: everyone who can read data finds it on the Reports page, and it always runs on
        the latest data.
      </p>
      <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
        Name
        <input type="text" className={INPUT} value={name} maxLength={200}
          onChange={e => onChange('name', e.target.value)} />
      </label>
      <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
        Description (optional)
        <textarea className={INPUT} rows={2} value={description} maxLength={2000}
          onChange={e => onChange('description', e.target.value)} />
      </label>
    </div>
  );
}

// Back / Next while there are steps left; Save (and, for a view, Save as new) on the last.
function WizardButtons({ current, isLast, editing, blocked, canSave, saving, onStep, onSave }) {
  const saveLabel = editing ? 'Save changes' : 'Save view';
  return (
    <div className="mt-5 flex flex-wrap gap-2">
      {current > 1 && (
        <button type="button" className={SECONDARY} onClick={() => onStep(current - 1)}>Back</button>
      )}
      {!isLast && (
        <button type="button" className={PRIMARY} disabled={blocked} onClick={() => onStep(current + 1)}>Next</button>
      )}
      {isLast && (
        <button type="button" className={PRIMARY} disabled={!canSave} onClick={() => onSave(false)}>
          {saving ? 'Saving…' : saveLabel}
        </button>
      )}
      {isLast && editing && (
        <button type="button" className={SECONDARY} disabled={!canSave} onClick={() => onSave(true)}>
          Save as a new view
        </button>
      )}
    </div>
  );
}
