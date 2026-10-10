// Organisation → Import wizard: the pieces the enrichment, activity and
// relation mapping steps share (presentational; every decision is a
// templateDraft.js / wizardDraft.js function).
//
//   ColumnSelect      a labelled select over the list's columns
//   TargetSelect      what a column refers to: a system type or a collection ('OrgEntity:<type>')
//   AttributeRows     extra columns kept as attributes (optionally with a "multiple values" toggle)
//   ActivityPreview   the first parsed rows and key counts of an activity dry run
//   MappingFooter     the stale-column notice, the problems list and the step's Next
import MappingRows from '@ui/components/MappingRows';
import { WizardNav } from '@ui/components/crawler/wizardFields';
import { recipeProblems, staleColumns, stepReady } from './wizardDraft';
import { KEY_ROLES, keyCountLine, periodText, previewRows, targetOptions, targetValue } from './templateDraft';
import { CELL_INPUT_CLS, CellSelect, Notice, SelectField } from './wizardUi';

const TH_CLS = 'text-left px-2 py-1 font-medium text-gray-600 dark:text-gray-400';
const TD_CLS = 'px-2 py-1 text-gray-800 dark:text-gray-200';

export function ColumnSelect({ label, value, columns, onChange, placeholder = 'Choose a column…' }) {
  return (
    <SelectField label={label} value={value ?? ''} onChange={onChange}>
      <option value="">{placeholder}</option>
      {columns.map(c => <option key={c} value={c}>{c}</option>)}
    </SelectField>
  );
}

export function TargetSelect({ label, end, base, collections, onChange }) {
  return (
    <SelectField label={label} value={targetValue(end)} onChange={onChange}>
      <option value="">Choose…</option>
      {targetOptions(base, collections, end).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </SelectField>
  );
}

export function AttributeRows({ rows, columns, owner, multi, onAdd, onRemove, onUpdate }) {
  const cols = [
    { key: 'column', render: (v, set) => <CellSelect label={`${owner} attribute column`} value={v} options={columns} placeholder="Column…" onChange={set} /> },
    { key: 'name', render: (v, set) => <input aria-label={`${owner} attribute name`} value={v ?? ''} onChange={e => set(e.target.value)} className={CELL_INPUT_CLS} /> },
  ];
  if (multi) {
    cols.push({ key: 'multi', render: (v, set) => (
      <label className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
        <input type="checkbox" checked={v === true} onChange={e => set(e.target.checked)} />
        Multiple values
      </label>
    ) });
  }
  return (
    <div>
      <p className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Attributes</p>
      <MappingRows
        rows={rows ?? []}
        minRows={0}
        headers={multi ? ['Column', 'Attribute name (default: the column)', 'One cell, several values'] : ['Column', 'Attribute name (default: the column)']}
        addLabel="+ Add attribute"
        onAdd={onAdd}
        onRemove={onRemove}
        onUpdate={onUpdate}
        columns={cols}
      />
    </div>
  );
}

export function ActivityPreview({ report }) {
  const rows = previewRows(report);
  return (
    <section className="space-y-2" aria-label="Activity preview">
      <p className="text-sm text-gray-700 dark:text-gray-300">
        {report.rows ?? 0} rows read, {report.activities ?? 0} activities{report.skipped > 0 ? `, ${report.skipped} skipped` : ''}.
      </p>
      <ul className="text-sm text-gray-800 dark:text-gray-200">
        {KEY_ROLES.filter(r => report.keys?.[r]).map(r => <li key={r}>{keyCountLine(r, report.keys[r])}</li>)}
      </ul>
      {rows.length > 0 && (
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-700/50">
            <tr><th className={TH_CLS}>Actor</th><th className={TH_CLS}>Subject</th><th className={TH_CLS}>When</th><th className={TH_CLS}>Measure</th></tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {rows.map((r, i) => (
              <tr key={i}>
                <td className={TD_CLS}>{r.actor}</td>
                <td className={TD_CLS}>{r.subject}</td>
                <td className={TD_CLS}>{periodText(r)}</td>
                <td className={TD_CLS}>{r.measure ?? ''}{r.unit ? ` ${r.unit}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function MappingFooter({ draft, onBack, onNext }) {
  const stale = staleColumns(draft);
  const problems = recipeProblems(draft);
  return (
    <>
      {stale.length > 0 && <Notice variant="warning">The list no longer has these columns the profile uses: {stale.join(', ')}.</Notice>}
      {problems.length > 0 && (
        <ul aria-label="Recipe problems" className="text-sm text-amber-800 dark:text-amber-200 list-disc ml-5">
          {problems.map(p => <li key={p}>{p}</li>)}
        </ul>
      )}
      <WizardNav onBack={onBack} onNext={onNext} nextDisabled={!stepReady(4, draft)} />
    </>
  );
}
