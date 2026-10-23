import { Field } from '@ui/components/contexts/ModalPrimitives';
import { TEMPLATE_OPTIONS, ROLE_FIELDS, withRole, toggleAttribute, usedColumns, treesOf, aiSuggested } from './uploadMapping.helpers';
import UploadMemberColumns from './UploadMemberColumns';
import AiMark from './AiMark';
import { ColumnRoleFields, AttributeColumns, MAPPING_INPUT as INPUT } from './MappingFields';

// Step "Mapping": the best guess, every part of it changeable — what the list
// holds, its name, which column is the name / key / owner / responsible /
// parent, the member columns, and which columns are kept as attributes.

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
        <ColumnRoleFields fields={ROLE_FIELDS} mapping={mapping} columns={columns} aiFields={ai}
          onPick={(field, column) => onChange(withRole(mapping, field, column))} />
      </div>
      <UploadMemberColumns mapping={mapping} columns={columns} aiFields={ai} onChange={onChange} />
      <AttributeColumns columns={analysis.columns} used={usedColumns(mapping)} selected={mapping.attributeColumns}
        onToggle={column => onChange(toggleAttribute(mapping, column))} />
      <p className="text-[11px] text-gray-600 dark:text-gray-400">Trees: {treesOf(mapping).join(' and ')}.</p>
    </div>
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
