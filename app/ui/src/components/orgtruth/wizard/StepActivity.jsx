// Import wizard step 4 for an activity (timesheets, logs): the activity's name,
// the actor column (people: accounts or identities), the subject column and
// what it refers to (a collection type from GET /api/org-truth/model, or
// Resource), when each row happened (a date column, or a year and a month
// column), the measure and its unit, extra columns kept as attributes, and a
// preview of the first parsed rows from a dry run (useDryRun; the report also
// fills the quality step). Presentational: every edit is a templateDraft.js
// edit through wizardDraft.editTemplate.
import { OptionList } from '@ui/components/crawler/wizardFields';
import { columnNames, editTemplate, recipeProblems } from './wizardDraft';
import {
  addSectionAttribute, patchPart, patchSection, removeSectionAttribute, setTarget, setWhenMode, updateSectionAttribute, whenMode,
} from './templateDraft';
import { useDryRun } from './useDryRun';
import { ActivityPreview, AttributeRows, ColumnSelect, MappingFooter, TargetSelect } from './templateUi';
import { useCollectionTypes } from './useCollectionTypes';
import { CARD_CLS, Field, Notice, SMALL_BTN_CLS } from './wizardUi';

const WHEN_OPTIONS = [
  { id: 'date', label: 'Date column', description: 'one column holds the date' },
  { id: 'yearMonth', label: 'Year and month columns', description: 'the row covers a month (names or numbers)' },
];

function WhenFields({ when, columns, edit }) {
  const mode = whenMode(when);
  const setWhen = (patch) => edit(r => patchPart(r, 'activity', 'when', patch));
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">When</legend>
      <OptionList options={WHEN_OPTIONS} name="activityWhen" selected={mode} onSelect={m => edit(r => setWhenMode(r, m))} />
      {mode === 'date' ? (
        <ColumnSelect label="Date column" value={when.dateColumn} columns={columns} onChange={v => setWhen({ dateColumn: v })} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ColumnSelect label="Year column" value={when.yearColumn} columns={columns} onChange={v => setWhen({ yearColumn: v })} />
          <ColumnSelect label="Month column" value={when.monthColumn} columns={columns} onChange={v => setWhen({ monthColumn: v })} />
        </div>
      )}
    </fieldset>
  );
}

function Preview({ draft, update }) {
  const { busy, notice, check } = useDryRun(draft, update);
  const ready = recipeProblems(draft).length === 0;
  return (
    <section className={`${CARD_CLS} space-y-2`}>
      <button type="button" onClick={check} disabled={busy || !ready || !draft.source} className={SMALL_BTN_CLS}>
        {busy ? 'Reading…' : 'Preview the first rows'}
      </button>
      {notice && <Notice variant="warning">{notice}</Notice>}
      {draft.quality?.keys && <ActivityPreview report={draft.quality} />}
    </section>
  );
}

export default function StepActivity({ draft, update, onBack, onNext }) {
  const columns = columnNames(draft);
  const collections = useCollectionTypes();
  const a = draft.recipe.activity;
  const edit = (fn) => update(d => editTemplate(d, fn));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Activity name" value={a.type} onChange={v => edit(r => patchSection(r, 'activity', { type: v }))}
          hint="How the activity reads, e.g. Hours." />
        <ColumnSelect label="Actor column" value={a.actor.column} columns={columns}
          onChange={v => edit(r => patchPart(r, 'activity', 'actor', { column: v }))} />
        <ColumnSelect label="Subject column" value={a.subject.column} columns={columns}
          onChange={v => edit(r => patchPart(r, 'activity', 'subject', { column: v }))} />
        <TargetSelect label="Subject refers to" end={a.subject} base={['Resource']} collections={collections}
          onChange={v => edit(r => setTarget(r, 'activity', 'subject', v))} />
      </div>
      <WhenFields when={a.when ?? {}} columns={columns} edit={edit} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ColumnSelect label="Measure column" value={a.measure?.column} columns={columns} placeholder="No measure"
          onChange={v => edit(r => patchPart(r, 'activity', 'measure', { column: v }))} />
        <Field label="Unit" value={a.measure?.unit ?? ''} onChange={v => edit(r => patchPart(r, 'activity', 'measure', { unit: v }))}
          hint="e.g. h for hours." />
      </div>
      <AttributeRows
        rows={a.attributes} columns={columns} owner="Activity"
        onAdd={() => edit(r => addSectionAttribute(r, 'activity'))}
        onRemove={j => edit(r => removeSectionAttribute(r, 'activity', j))}
        onUpdate={(j, key, val) => edit(r => updateSectionAttribute(r, 'activity', j, { [key]: val }))}
      />
      <Preview draft={draft} update={update} />
      <MappingFooter draft={draft} onBack={onBack} onNext={onNext} />
    </div>
  );
}
