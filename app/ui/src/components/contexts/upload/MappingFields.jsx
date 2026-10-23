import { Field } from '@ui/components/contexts/ModalPrimitives';
import AiMark from './AiMark';
import { aiSuggested } from './uploadMapping.helpers';

// The mapping-form pieces an upload wizard is built from — shared by "Upload a
// list" (UploadMappingStep) and "Upload activity" (ActivityMappingStep):
//   ColumnRoleFields  one column picker per role, with the AI mark on what the AI chose
//   AttributeColumns  tick the columns no role takes, to keep them as attributes

export const MAPPING_INPUT = 'w-full border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600';

// fields: [{ field, label, help?, required? }]; onPick(field, column) — '' for none.
export function ColumnRoleFields({ fields, mapping, columns, aiFields, onPick }) {
  return fields.map(r => (
    <Field key={r.field} label={<>{r.label}{r.required ? ' *' : ''}<AiMark show={aiSuggested(aiFields, r.field)} /></>} help={r.help}>
      <select aria-label={r.label} value={mapping[r.field] || ''} className={MAPPING_INPUT} onChange={e => onPick(r.field, e.target.value)}>
        <option value="">{r.required ? '(choose a column)' : '(none)'}</option>
        {columns.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
    </Field>
  ));
}

// columns: the analysis's [{ header, samples }]; used: the Set of columns a role takes.
export function AttributeColumns({ columns, used, selected, onToggle, legend = 'Keep as attributes' }) {
  const free = columns.filter(c => !used.has(c.header));
  if (free.length === 0) return null;
  return (
    <fieldset>
      <legend className="text-xs font-medium text-gray-700 dark:text-gray-300">{legend}</legend>
      <ul className="mt-1 grid grid-cols-1 gap-x-3 sm:grid-cols-2">
        {free.map(c => (
          <li key={c.header}>
            <label className="flex items-start gap-1.5 text-xs text-gray-800 dark:text-gray-200">
              <input type="checkbox" checked={selected.includes(c.header)} onChange={() => onToggle(c.header)} className="mt-0.5" />
              <span>
                {c.header}
                {c.samples?.length > 0 && <span className="block text-[11px] text-gray-600 dark:text-gray-400">{c.samples.slice(0, 3).join(', ')}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
