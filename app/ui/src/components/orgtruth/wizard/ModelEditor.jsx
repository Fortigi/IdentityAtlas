// Import wizard step 3, the editor half: entities (type, name column, key
// column, attributes) and relations (predicate, from type, to type), on the
// shared MappingRows grid. Presentational: every edit is a wizardDraft.js call.
import MappingRows from '@ui/components/MappingRows';
import {
  addAttribute, addEntity, addRelation, columnNames, removeAttribute, removeEntity, removeRelation,
  updateAttribute, updateEntity, updateRelation,
} from './wizardDraft';
import { CARD_CLS, CELL_INPUT_CLS, CellSelect, LINK_BTN_CLS } from './wizardUi';

function EntityCard({ entity, i, columns, update }) {
  const label = entity.type || `Entity ${i + 1}`;
  return (
    <div className={CARD_CLS}>
      <div className="flex flex-wrap items-end gap-3 mb-3">
        <div className="flex-1 min-w-[10rem]">
          <input aria-label={`Entity ${i + 1} type`} value={entity.type} placeholder="Type, e.g. Project"
            onChange={e => update(d => updateEntity(d, i, { type: e.target.value }))} className={CELL_INPUT_CLS} />
        </div>
        <div className="flex-1 min-w-[10rem]">
          <CellSelect label={`${label} name column`} value={entity.nameColumn} options={columns} placeholder="Name column…"
            onChange={v => update(d => updateEntity(d, i, { nameColumn: v }))} />
        </div>
        <div className="flex-1 min-w-[10rem]">
          <CellSelect label={`${label} key column`} value={entity.keyColumn} options={columns} placeholder="Key: same as name"
            onChange={v => update(d => updateEntity(d, i, { keyColumn: v }))} />
        </div>
        <button type="button" onClick={() => update(d => removeEntity(d, i))} className={LINK_BTN_CLS}>
          Remove {label}
        </button>
      </div>
      <p className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Attributes</p>
      <MappingRows
        rows={entity.attributes ?? []}
        minRows={0}
        headers={['Column', 'Attribute name (default: the column)']}
        addLabel="+ Add attribute"
        onAdd={() => update(d => addAttribute(d, i))}
        onRemove={j => update(d => removeAttribute(d, i, j))}
        onUpdate={(j, key, val) => update(d => updateAttribute(d, i, j, { [key]: val }))}
        columns={[
          { key: 'column', render: (v, set) => <CellSelect label={`${label} attribute column`} value={v} options={columns} placeholder="Column…" onChange={set} /> },
          { key: 'name', render: (v, set) => <input aria-label={`${label} attribute name`} value={v ?? ''} onChange={e => set(e.target.value)} className={CELL_INPUT_CLS} /> },
        ]}
      />
    </div>
  );
}

export default function ModelEditor({ draft, update }) {
  const columns = columnNames(draft);
  const types = draft.recipe.entities.map(e => e.type).filter(Boolean);
  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Entities</h4>
        {draft.recipe.entities.map((e, i) => <EntityCard key={i} entity={e} i={i} columns={columns} update={update} />)}
        <button type="button" onClick={() => update(addEntity)} className={LINK_BTN_CLS}>+ Add entity</button>
      </div>
      <div className="space-y-2">
        <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Relations</h4>
        <MappingRows
          rows={draft.recipe.relations}
          minRows={0}
          headers={['Predicate', 'From', 'To']}
          addLabel="+ Add relation"
          onAdd={() => update(addRelation)}
          onRemove={k => update(d => removeRelation(d, k))}
          onUpdate={(k, key, val) => update(d => updateRelation(d, k, { [key]: val }))}
          columns={[
            { key: 'predicate', render: (v, set) => <input aria-label="Relation predicate" value={v} placeholder="e.g. owner" onChange={e => set(e.target.value)} className={CELL_INPUT_CLS} /> },
            { key: 'from', render: (v, set) => <CellSelect label="Relation from" value={v} options={types} placeholder="From…" onChange={set} /> },
            { key: 'to', render: (v, set) => <CellSelect label="Relation to" value={v} options={types} placeholder="To…" onChange={set} /> },
          ]}
        />
      </div>
    </div>
  );
}
