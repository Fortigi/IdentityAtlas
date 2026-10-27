// Context builder — header and scope settings. Presentational only; the page owns the draft.

import { MUTED } from '@ui/components/reports/ask/AskAssistant.styles';
import ContextCategorySelect from '@ui/components/contexts/ContextCategorySelect';

export const CARD = 'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800';
export const H3 = 'mb-2 text-sm font-semibold text-gray-900 dark:text-white';
const PRIMARY = 'rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600';
const SECONDARY = 'rounded bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600';
const INPUT = 'w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100';

export function BuilderHeader({ contextId, memberCount, evaluating, blocker, saving, message, onSave, onOpenContext }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id="ctx-builder-heading" className="text-lg font-semibold text-gray-900 dark:text-white">
          {contextId ? 'Edit context' : 'New context'}
          <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 align-middle text-xs font-medium text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">experimental</span>
        </h2>
        <p className={MUTED} aria-live="polite">
          {evaluating ? 'Checking what the terms find…' : `${memberCount} objects in the context`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {message && (
          <span role="status" className={message.kind === 'ok' ? 'text-sm text-green-700 dark:text-green-300' : 'text-sm text-red-700 dark:text-red-300'}>{message.text}</span>
        )}
        {contextId && <button type="button" className={SECONDARY} onClick={onOpenContext}>Open context</button>}
        <button type="button" className={PRIMARY} disabled={saving || evaluating || !!blocker} title={blocker || undefined} onClick={onSave}>
          {saving ? 'Saving…' : contextId ? 'Save and refresh' : 'Create context'}
        </button>
      </div>
    </div>
  );
}

function Toggles({ legend, values, selected, labelOf = v => v, onToggle }) {
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-medium text-gray-800 dark:text-gray-200">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {values.map(v => (
          <label key={v} className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
            <input type="checkbox" checked={selected.includes(v)} onChange={() => onToggle(v)} className="h-4 w-4" />
            {labelOf(v)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// What the context is: the same template choice the new-context wizard offers.
// Describe only finds resources today, so an Organisation context made here is
// a unit's Resources tree, not a unit of people.
function TemplateChoice({ value, byModel, onChange }) {
  return (
    <div>
      <label htmlFor="ctx-template" className="mb-1 block text-sm font-medium text-gray-800 dark:text-gray-200">
        This context is
        {byModel && <span className="ml-2 rounded bg-violet-50 px-1.5 py-0.5 text-xs font-normal text-violet-800 dark:bg-violet-900/30 dark:text-violet-300">suggested by the model</span>}
      </label>
      <ContextCategorySelect id="ctx-template" value={value} onChange={onChange} className={INPUT} />
      <p className={`mt-1 ${MUTED}`}>The assistant finds groups and other resources, so the context holds resources — for an organisation, its Resources tree.</p>
    </div>
  );
}

// The likely Accountable, shown before saving; it is offered to confirm on the context page.
function SuggestedOwner({ owner }) {
  if (!owner) return null;
  return (
    <p className="text-sm text-gray-700 dark:text-gray-300" data-testid="suggested-owner">
      Suggested owner: <span className="font-medium">{owner.displayName}</span> — {owner.reason}.
      <span className={`block ${MUTED}`}>Confirm it on the context page after saving.</span>
    </p>
  );
}

/**
 * Name, template, structure, and where to search: which kinds of object, which of their fields.
 */
export function SettingsPanel({
  recipe, options, fieldLabels, onName, onStructure, onToggleType, onToggleField, templateByModel, onTemplate, suggestedOwner,
}) {
  const types = [...new Set([...(options?.resourceTypes || []), ...recipe.resourceTypes])];
  return (
    <div className={`${CARD} grid gap-4 md:grid-cols-2`}>
      <div className="space-y-3">
        <div>
          <label htmlFor="ctx-name" className="mb-1 block text-sm font-medium text-gray-800 dark:text-gray-200">Name</label>
          <input id="ctx-name" className={INPUT} value={recipe.name} onChange={e => onName(e.target.value)} placeholder="e.g. Inkoopproces" />
        </div>
        <TemplateChoice value={recipe.template} byModel={templateByModel} onChange={onTemplate} />
        <SuggestedOwner owner={suggestedOwner} />
        <div>
          <label htmlFor="ctx-structure" className="mb-1 block text-sm font-medium text-gray-800 dark:text-gray-200">Structure</label>
          <select id="ctx-structure" className={INPUT} value={recipe.structure} onChange={e => onStructure(e.target.value)}>
            <option value="byTerm">A child context per term (shows why a group is in it)</option>
            <option value="flat">One context with every group</option>
          </select>
        </div>
      </div>
      <div className="space-y-3">
        <Toggles legend="Search in" values={Object.keys(fieldLabels)} selected={recipe.fields} labelOf={f => fieldLabels[f]} onToggle={onToggleField} />
        <Toggles legend="Kinds of object" values={types} selected={recipe.resourceTypes} onToggle={onToggleType} />
      </div>
    </div>
  );
}
