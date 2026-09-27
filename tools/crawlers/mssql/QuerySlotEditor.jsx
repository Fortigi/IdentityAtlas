// One query slot of the SQL wizard's Queries step: name, target, the slot
// constants the target uses, the SQL, an enabled toggle and a remove button.
// A slot is a multi-line card (an 8-row SQL textarea), which is why the slot
// itself is not a MappingRows row — its column mapping is.
import MappingRows from '@ui/components/MappingRows';
import Select from '@ui/components/inputs/Select';
import { CrawlerField } from '@ui/components/crawler/wizardFields';
import {
  ASSIGNMENT_TYPES, CONTEXT_TARGET_TYPES, PRINCIPAL_TYPES, RELATIONSHIP_TYPES, TARGETS,
  contractColumnOptions, contractColumnsFor, newColumnMapRow, slotFieldsFor,
} from './wizardLogic.js';

const SMALL_CLS = 'text-sm border border-gray-300 rounded px-2 py-1 bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';
const LABEL_CLS = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';
const CHECK_CLS = 'flex items-center gap-2 cursor-pointer text-sm text-gray-700 dark:text-gray-300';

function EnumSelect({ label, value, options, onChange }) {
  return (
    <div>
      <label className={LABEL_CLS}>{label}</label>
      <Select value={value} onChange={e => onChange(e.target.value)} className={SMALL_CLS}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </Select>
    </div>
  );
}

// The slot-level constants crawler.json defines per target (resourceType,
// assignmentType, governed, relationshipType, principalType, contextType,
// targetType, memberType). Only the ones the
// current target uses are shown — the others are dropped on save anyway.
function SlotFields({ slot, update }) {
  const fields = slotFieldsFor(slot.target);
  if (fields.length === 0) return null;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {fields.includes('resourceType') && (
        <div>
          <label className={LABEL_CLS}>Resource type</label>
          <input value={slot.resourceType} onChange={e => update('resourceType', e.target.value)}
            placeholder="Entitlement" className={'w-full ' + SMALL_CLS} />
        </div>
      )}
      {fields.includes('assignmentType') && (
        <EnumSelect label="Assignment type" value={slot.assignmentType} options={ASSIGNMENT_TYPES} onChange={v => update('assignmentType', v)} />
      )}
      {fields.includes('governed') && (
        <label className={CHECK_CLS + ' pt-5'}>
          <input type="checkbox" checked={slot.governed === true} onChange={e => update('governed', e.target.checked)} />
          Governed
        </label>
      )}
      {fields.includes('relationshipType') && (
        <EnumSelect label="Relationship type" value={slot.relationshipType} options={RELATIONSHIP_TYPES} onChange={v => update('relationshipType', v)} />
      )}
      {fields.includes('principalType') && (
        <EnumSelect label="Default principal type" value={slot.principalType} options={PRINCIPAL_TYPES} onChange={v => update('principalType', v)} />
      )}
      {fields.includes('contextType') && (
        <div>
          <label className={LABEL_CLS}>Context type</label>
          <input value={slot.contextType} onChange={e => update('contextType', e.target.value)}
            placeholder="Application" className={'w-full ' + SMALL_CLS} />
        </div>
      )}
      {fields.includes('targetType') && (
        <EnumSelect label="Groups" value={slot.targetType} options={CONTEXT_TARGET_TYPES} onChange={v => update('targetType', v)} />
      )}
      {fields.includes('memberType') && (
        <EnumSelect label="Member type" value={slot.memberType} options={CONTEXT_TARGET_TYPES} onChange={v => update('memberType', v)} />
      )}
    </div>
  );
}

// ─── Column mapping ──────────────────────────────────────────────────────────

const MAP_FIELD_CLS = 'w-full ' + SMALL_CLS;
const BADGE_CLS = 'ml-1.5 px-1.5 py-0.5 bg-blue-50 text-blue-700 text-[10px] rounded dark:bg-blue-900/30 dark:text-blue-300';

// "id and displayName", "parentId and childId" — the required columns read as a
// sentence fragment.
function andList(columns) {
  if (columns.length < 2) return columns.join('');
  return `${columns.slice(0, -1).join(', ')} and ${columns[columns.length - 1]}`;
}

// The contract columns of the slot's target, required first. A stored value the
// target no longer recognises (the target was changed under it) is kept as an
// option so the row shows what is wrong instead of silently reading as blank —
// validateColumnMap reports it in the Queries-step error list.
function ContractOptions({ target, value }) {
  const { required, optional } = contractColumnsFor(target);
  const stale = value && !contractColumnOptions(target).includes(value);
  return (
    <>
      <option value="">(choose)</option>
      <optgroup label="Required">{required.map(c => <option key={c} value={c}>{c}</option>)}</optgroup>
      <optgroup label="Optional">{optional.map(c => <option key={c} value={c}>{c}</option>)}</optgroup>
      {stale && <option value={value}>{value} (not a {target} column)</option>}
    </>
  );
}

// Collapsed until the slot has a mapping: renaming columns in the SELECT is the
// normal way to satisfy the contract, and this is the escape hatch for SQL the
// operator cannot or will not change.
function ColumnMapSection({ slot, update }) {
  const rows = Array.isArray(slot.columnMap) ? slot.columnMap : [];
  const { required } = contractColumnsFor(slot.target);
  if (required.length === 0) return null;
  const setRows = next => update('columnMap', next);
  return (
    <details open={rows.length > 0}>
      <summary className="text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
        Column mapping
        {rows.length > 0 && <span className={BADGE_CLS}>{rows.length}</span>}
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          <code>{slot.target}</code> needs {andList(required)} — map your columns to them if your SELECT does not already use those names.
        </p>
        <MappingRows
          rows={rows}
          onAdd={() => setRows([...rows, newColumnMapRow()])}
          onRemove={i => setRows(rows.filter((_, idx) => idx !== i))}
          onUpdate={(i, key, value) => setRows(rows.map((row, idx) => (idx === i ? { ...row, [key]: value } : row)))}
          headers={['Source column', 'Maps to']}
          addLabel="+ Add mapping"
          minRows={0}
          columns={[
            { key: 'from', render: (v, onChange) => (
              <input value={v || ''} onChange={e => onChange(e.target.value)} placeholder="EntitlementID" className={MAP_FIELD_CLS} />
            ) },
            { key: 'to', render: (v, onChange) => (
              <Select value={v || ''} onChange={e => onChange(e.target.value)} className={SMALL_CLS}>
                <ContractOptions target={slot.target} value={v} />
              </Select>
            ) },
          ]}
        />
      </div>
    </details>
  );
}

export default function QuerySlotEditor({ slot, index, onUpdate, onRemove }) {
  const update = (field, value) => onUpdate(index, field, value);
  const target = TARGETS.find(t => t.id === slot.target);
  return (
    <div className="p-3 border border-gray-200 rounded dark:border-gray-700 space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-0">
          <label className={LABEL_CLS}>Name</label>
          <input value={slot.name} onChange={e => update('name', e.target.value)}
            placeholder="Identities" className={'w-full ' + SMALL_CLS} />
        </div>
        <div className="w-44">
          <label className={LABEL_CLS}>Target</label>
          <Select value={slot.target} onChange={e => update('target', e.target.value)} className={SMALL_CLS}>
            {TARGETS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </Select>
        </div>
        <label className={CHECK_CLS + ' pb-1.5'}>
          <input type="checkbox" checked={slot.enabled !== false} onChange={e => update('enabled', e.target.checked)} />
          Enabled
        </label>
        <button type="button" onClick={() => onRemove(index)} title="Remove query"
          className="pb-1 text-gray-600 dark:text-gray-400 hover:text-red-500 text-lg leading-none">
          ×
        </button>
      </div>
      <SlotFields slot={slot} update={update} />
      <CrawlerField
        label="SQL" mono rows={8} value={slot.sql} onChange={v => update('sql', v)}
        placeholder="SELECT … FROM …"
        hint={target ? <>Columns for <code>{target.id}</code>: {target.contract}</> : null}
      />
      <ColumnMapSection slot={slot} update={update} />
    </div>
  );
}
