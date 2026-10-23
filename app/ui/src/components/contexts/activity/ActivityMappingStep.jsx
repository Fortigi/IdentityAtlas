import { Field } from '@ui/components/contexts/ModalPrimitives';
import AiMark from '@ui/components/contexts/upload/AiMark';
import { ColumnRoleFields, AttributeColumns, MAPPING_INPUT as INPUT } from '@ui/components/contexts/upload/MappingFields';
import { aiSuggested, toggleAttribute } from '@ui/components/contexts/upload/uploadMapping.helpers';
import { activityRoleFields, withActivityRole, usedActivityColumns, UNIT_OPTIONS, DATE_ORDER_OPTIONS } from './activity.helpers';

// Step "Mapping" of Upload activity: the best guess, every part changeable —
// the source, which column names the sub-unit (on a context with sub-units),
// the person, the date and how to read it, the amount and its unit, the kind,
// and which other columns are kept on each row. Built from the list upload's
// mapping pieces (upload/MappingFields.jsx).

export default function ActivityMappingStep({ analysis, mapping, onChange }) {
  const columns = analysis.columns.map(c => c.header);
  const ai = analysis.aiFields;
  const set = (patch) => onChange({ ...mapping, ...patch });
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {analysis.rowCount} rows in {analysis.fileName}. This is a best guess{analysis.aiUsed ? ', partly by the AI' : ''}; change anything that is wrong.
        {analysis.previousUpload?.mappingReused && ' It starts from the mapping of the previous upload of this source.'}
      </p>
      {analysis.hasChildren && (
        <p className="text-xs text-gray-600 dark:text-gray-400">This context has {analysis.subUnitCount} sub-units below it: each row lands on the one its sub-unit column names.</p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Source" help="A later upload of the same source here replaces the overlapping period.">
          <input aria-label="Source" value={mapping.sourceLabel} className={INPUT} onChange={e => set({ sourceLabel: e.target.value })} />
        </Field>
        <ColumnRoleFields fields={activityRoleFields(analysis.hasChildren)} mapping={mapping} columns={columns} aiFields={ai}
          onPick={(field, column) => onChange(withActivityRole(mapping, field, column))} />
        <Field label="Dates are written">
          <select aria-label="Dates are written" value={mapping.dateOrder} className={INPUT} onChange={e => set({ dateOrder: e.target.value })}>
            {DATE_ORDER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field label={<>Unit<AiMark show={aiSuggested(ai, 'unit')} /></>} help={mapping.amountColumn ? undefined : 'Without an amount column every row is one event.'}>
          <select aria-label="Unit" value={mapping.unit} disabled={!mapping.amountColumn} className={`${INPUT} disabled:opacity-60`} onChange={e => set({ unit: e.target.value })}>
            {UNIT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
      </div>
      <AttributeColumns columns={analysis.columns} used={usedActivityColumns(mapping)} selected={mapping.attributeColumns}
        legend="Keep on each row" onToggle={column => onChange(toggleAttribute(mapping, column))} />
    </div>
  );
}
