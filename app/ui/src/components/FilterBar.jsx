import { useState, useMemo } from 'react';

/**
 * Reusable pill-based filter bar.
 * Renders inline elements (React Fragment) — place inside a flex container.
 *
 * Props:
 *   label          – Section label (e.g. "User Filters:", "Filters:")
 *   filterFields   – [{key, label}] available fields
 *   activeFilters  – [{field, value}] ALL active filters (bar only shows its own)
 *   getOptionsForField(fieldKey) → string[]
 *   onAddFilter(field, value)
 *   onRemoveFilter(field)
 *   loading        – (optional) true while filter columns are being fetched
 */
export default function FilterBar({
  label,
  filterFields,
  activeFilters,
  getOptionsForField,
  onAddFilter,
  onRemoveFilter,
  loading = false,
}) {
  const [adding, setAdding] = useState(false);
  const [selectedField, setSelectedField] = useState('');

  // Only show active filters belonging to this bar's fields
  const myFieldKeys = useMemo(() => new Set(filterFields.map(f => f.key)), [filterFields]);
  const myActiveFilters = useMemo(
    () => activeFilters.filter(af => myFieldKeys.has(af.field)),
    [activeFilters, myFieldKeys],
  );

  // Fields not yet used as active filters
  const availableFields = useMemo(() => {
    const used = new Set(activeFilters.map(f => f.field));
    return filterFields.filter(f => !used.has(f.key));
  }, [filterFields, activeFilters]);

  const newFilterOptions = useMemo(() => {
    if (!selectedField) return [];
    return getOptionsForField(selectedField);
  }, [selectedField, getOptionsForField]);

  const handleAddValue = (value) => {
    if (selectedField && value) onAddFilter(selectedField, value);
    setAdding(false);
    setSelectedField('');
  };

  const handleClearAll = () => {
    myActiveFilters.forEach(af => onRemoveFilter(af.field));
  };

  return (
    <>
      <span className="font-medium text-gray-700 dark:text-gray-300">{label}</span>

      {/* Active filter pills */}
      {myActiveFilters.map(af => {
        const field = filterFields.find(f => f.key === af.field);
        return (
          <span
            key={af.field}
            className="inline-flex items-center gap-1 px-2 py-1 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded text-xs"
          >
            <span className="font-medium text-blue-700 dark:text-blue-300">{field?.label || af.field}:</span>
            <select
              value={af.value}
              onChange={e => onAddFilter(af.field, e.target.value)}
              className="bg-transparent border-none text-blue-900 dark:text-blue-200 text-xs font-medium cursor-pointer p-0 pr-4"
            >
              {getOptionsForField(af.field).map(v => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
            <button
              onClick={() => onRemoveFilter(af.field)}
              className="text-blue-400 dark:text-blue-500 hover:text-blue-700 dark:hover:text-blue-300 font-bold ml-0.5"
              title="Remove filter"
            >
              &times;
            </button>
          </span>
        );
      })}

      {/* Add filter inline selector */}
      {adding ? (
        <span className="inline-flex items-center gap-1 px-2 py-1 bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded text-xs">
          <select
            autoFocus
            value={selectedField}
            onChange={e => setSelectedField(e.target.value)}
            className="bg-transparent border-none text-xs dark:text-gray-200 p-0 pr-4"
          >
            <option value="">Select field...</option>
            {availableFields.map(f => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </select>
          {selectedField && (
            <>
              <span className="text-gray-400 dark:text-gray-500">=</span>
              <select
                value=""
                onChange={e => handleAddValue(e.target.value)}
                className="bg-transparent border-none text-xs dark:text-gray-200 p-0 pr-4"
              >
                <option value="">Select value...</option>
                {newFilterOptions.map(v => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </>
          )}
          <button
            onClick={() => { setAdding(false); setSelectedField(''); }}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 font-bold"
          >
            &times;
          </button>
        </span>
      ) : loading && filterFields.length === 0 ? (
        <span className="inline-flex items-center gap-1.5 px-2 py-1 text-xs text-gray-400 dark:text-gray-500">
          <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading filters...
        </span>
      ) : (
        availableFields.length > 0 && (
          <button
            onClick={() => setAdding(true)}
            className="px-2 py-1 rounded text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 border border-blue-200 dark:border-blue-700 border-dashed"
          >
            + Add filter
          </button>
        )
      )}

      {myActiveFilters.length > 1 && (
        <button
          onClick={handleClearAll}
          className="px-2 py-1 rounded text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
          title="Clear all filters"
        >
          Clear all
        </button>
      )}
    </>
  );
}
