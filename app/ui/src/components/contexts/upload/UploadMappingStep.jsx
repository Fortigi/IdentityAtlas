import { Field } from '@ui/components/contexts/ModalPrimitives';
import { TEMPLATE_OPTIONS, ROLE_FIELDS, withRole, toggleAttribute, usedColumns, treesOf, aiSuggested } from './uploadMapping.helpers';
import UploadMemberColumns from './UploadMemberColumns';
import AiMark from './AiMark';

// Step "Mapping": the best guess, every part of it changeable — what the list
// holds, its name, which column is the name / key / owner / responsible /
// parent, the member columns, and which columns are kept as attributes.

const INPUT = 'w-full border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600';

export default function UploadMappingStep({ analysis, mapping, onChange, listLocked, existingOffer, onUseExisting }) {
  const columns = analysis.columns.map(c => c.header);
  const ai = analysis.aiFields;
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {analysis.rowCount} rows in {analysis.fileName}. This is a best guess{analysis.aiUsed ? ', partly by the AI' : ''}; change anything that is wrong.
      </p>
      {existingOffer && <ExistingListOffer list={existingOffer} onUse={onUseExisting} />}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={<>The list holds<AiMark show={aiSuggested(ai, 'template')} /></>}>
          <select aria-label="The list holds" value={mapping.template} className={INPUT} onChange={e => onChange({ ...mapping, template: e.target.value })}>
            {TEMPLATE_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Field>
        <Field label={<>List name<AiMark show={aiSuggested(ai, 'listName')} /></>} help={listLocked ? 'An existing list keeps its name.' : 'The name of the tree.'}>
          <input aria-label="List name" value={mapping.listName} disabled={listLocked} className={`${INPUT} disabled:opacity-60`}
            onChange={e => onChange({ ...mapping, listName: e.target.value })} />
        </Field>
        {ROLE_FIELDS.map(r => (
          <Field key={r.field} label={<>{r.label}{r.required ? ' *' : ''}<AiMark show={aiSuggested(ai, r.field)} /></>} help={r.help}>
            <select aria-label={r.label} value={mapping[r.field] || ''} className={INPUT} onChange={e => onChange(withRole(mapping, r.field, e.target.value))}>
              <option value="">{r.required ? '(choose a column)' : '(none)'}</option>
              {columns.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        ))}
      </div>
      <UploadMemberColumns mapping={mapping} columns={columns} aiFields={ai} onChange={onChange} />
      <AttributeColumns analysis={analysis} mapping={mapping} onChange={onChange} />
      <p className="text-[11px] text-gray-600 dark:text-gray-400">Trees: {treesOf(mapping).join(' and ')}.</p>
    </div>
  );
}

// The columns no role takes: tick the ones to keep on each unit as attributes.
function AttributeColumns({ analysis, mapping, onChange }) {
  const used = usedColumns(mapping);
  const free = analysis.columns.filter(c => !used.has(c.header));
  if (free.length === 0) return null;
  return (
    <fieldset>
      <legend className="text-xs font-medium text-gray-700 dark:text-gray-300">Keep as attributes</legend>
      <ul className="mt-1 grid grid-cols-1 gap-x-3 sm:grid-cols-2">
        {free.map(c => (
          <li key={c.header}>
            <label className="flex items-start gap-1.5 text-xs text-gray-800 dark:text-gray-200">
              <input type="checkbox" checked={mapping.attributeColumns.includes(c.header)} onChange={() => onChange(toggleAttribute(mapping, c.header))} className="mt-0.5" />
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

// A list of this name was uploaded before: offer to update it (never assume).
function ExistingListOffer({ list, onUse }) {
  return (
    <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300" role="status">
      A list called “{list.listName}” was uploaded before{list.lastFileName ? ` (${list.lastFileName})` : ''}.
      <button type="button" onClick={onUse} className="ml-1 font-medium underline">Update that list</button>
      {' '}or give this one another name.
    </div>
  );
}
