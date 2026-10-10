// Import wizard step 4 for an enrichment: the list's name (its attributes are
// labelled with it), what it adds information to (Identity, Principal or
// Resource), the key column whose values say who or what a row is about, and
// the attributes, each with a "multiple values" toggle (one cell, several
// values). The rule that matches the key to the target is accepted on the
// links step, the collection's step 5. Presentational: every edit is a
// wizardDraft.js / templateDraft.js call.
import { addAttribute, columnNames, editTemplate, removeAttribute, updateAttribute, updateEntity } from './wizardDraft';
import { ENRICH_TARGETS, patchSection } from './templateDraft';
import { AttributeRows, ColumnSelect, MappingFooter } from './templateUi';
import { Field, SelectField } from './wizardUi';

export default function StepEnrichment({ draft, update, onBack, onNext }) {
  const columns = columnNames(draft);
  const entity = draft.recipe.entities[0] ?? {};
  const target = draft.recipe.enrich?.targetType ?? '';
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Field label="List name" value={entity.type ?? ''} onChange={v => update(d => updateEntity(d, 0, { type: v }))}
          hint="Its attributes are labelled with this name, e.g. Expertise." />
        <SelectField label="Adds information to" value={target}
          onChange={v => update(d => editTemplate(d, r => patchSection(r, 'enrich', { targetType: v })))}>
          {ENRICH_TARGETS.map(t => <option key={t} value={t}>{t}</option>)}
        </SelectField>
        <ColumnSelect label="Key column" value={entity.nameColumn} columns={columns}
          onChange={v => update(d => updateEntity(d, 0, { nameColumn: v, keyColumn: '' }))} />
      </div>
      <AttributeRows
        rows={entity.attributes} columns={columns} owner={entity.type || 'Enrichment'} multi
        onAdd={() => update(d => addAttribute(d, 0))}
        onRemove={j => update(d => removeAttribute(d, 0, j))}
        onUpdate={(j, key, val) => update(d => updateAttribute(d, 0, j, { [key]: val }))}
      />
      <p className="text-sm text-gray-700 dark:text-gray-300">
        The next step matches the key column to {target || 'the target'}; the attributes then belong to the matched {target || 'object'}.
      </p>
      <MappingFooter draft={draft} onBack={onBack} onNext={onNext} />
    </div>
  );
}
