// Generic add/remove mapping-row grid for crawler ConfigWizard components.
// Each column renders its own input via a `render(value, onChange)` callback.
//
// Props:
//   rows      — array of row objects
//   onAdd     — () => void          — append a blank row
//   onRemove  — (i) => void         — remove row at index i
//   onUpdate  — (i, key, val) => void  — update one field of row i
//   columns   — [{ key, render(value, onChange) }]
//   headers   — optional string[]   — column header labels
//   addLabel  — string (default '+ Add row')
//   minRows   — int (default 1)     — remove button disabled when rows.length ≤ minRows
export default function MappingRows({
  rows,
  onAdd,
  onRemove,
  onUpdate,
  columns,
  headers,
  addLabel = '+ Add row',
  minRows = 1,
}) {
  return (
    <div className="space-y-2">
      {headers && (
        <div className="flex gap-2 text-xs font-medium text-gray-500 dark:text-gray-400 pr-6 mb-1">
          {headers.map((h, i) => <span key={i} className="flex-1 min-w-0">{h}</span>)}
        </div>
      )}
      {rows.map((row, i) => (
        <div key={i} className="flex gap-2 items-center">
          {columns.map(col => (
            <div key={col.key} className="flex-1 min-w-0">
              {col.render(row[col.key], (val) => onUpdate(i, col.key, val))}
            </div>
          ))}
          <button
            onClick={() => onRemove(i)}
            disabled={rows.length <= minRows}
            className="text-gray-600 dark:text-gray-400 hover:text-red-500 text-lg leading-none disabled:opacity-30"
            title="Remove">
            ×
          </button>
        </div>
      ))}
      <button
        onClick={onAdd}
        className="mt-2 text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-300">
        {addLabel}
      </button>
    </div>
  );
}
