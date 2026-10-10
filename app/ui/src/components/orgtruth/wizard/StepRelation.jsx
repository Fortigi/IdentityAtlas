// Import wizard step 4 for a relation (pairs between things, e.g. an SoD
// matrix): the relation's name and predicate, the left and the right column
// with what each refers to (Resource, Principal, Identity or a collection
// type from GET /api/org-truth/model), and extra columns kept as attributes.
// Presentational: every edit is a templateDraft.js edit through
// wizardDraft.editTemplate.
import { columnNames, editTemplate } from './wizardDraft';
import {
  END_TARGETS, addSectionAttribute, patchPart, patchSection, removeSectionAttribute, setTarget, updateSectionAttribute,
} from './templateDraft';
import { AttributeRows, ColumnSelect, MappingFooter, TargetSelect } from './templateUi';
import { useCollectionTypes } from './useCollectionTypes';
import { Field } from './wizardUi';

const SIDES = [['left', 'Left'], ['right', 'Right']];

export default function StepRelation({ draft, update, onBack, onNext }) {
  const columns = columnNames(draft);
  const collections = useCollectionTypes();
  const rel = draft.recipe.relation;
  const edit = (fn) => update(d => editTemplate(d, fn));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Relation name" value={rel.type} onChange={v => edit(r => patchSection(r, 'relation', { type: v }))}
          hint="What one pair is, e.g. Incompatibility." />
        <Field label="Predicate" value={rel.predicate} onChange={v => edit(r => patchSection(r, 'relation', { predicate: v }))}
          hint="How left relates to right, e.g. incompatibleWith." />
        {SIDES.map(([side, label]) => [
          <ColumnSelect key={`${side}-col`} label={`${label} column`} value={rel[side].column} columns={columns}
            onChange={v => edit(r => patchPart(r, 'relation', side, { column: v }))} />,
          <TargetSelect key={`${side}-target`} label={`${label} refers to`} end={rel[side]} base={END_TARGETS} collections={collections}
            onChange={v => edit(r => setTarget(r, 'relation', side, v))} />,
        ])}
      </div>
      <AttributeRows
        rows={rel.attributes} columns={columns} owner="Relation"
        onAdd={() => edit(r => addSectionAttribute(r, 'relation'))}
        onRemove={j => edit(r => removeSectionAttribute(r, 'relation', j))}
        onUpdate={(j, key, val) => edit(r => updateSectionAttribute(r, 'relation', j, { [key]: val }))}
      />
      <MappingFooter draft={draft} onBack={onBack} onNext={onNext} />
    </div>
  );
}
