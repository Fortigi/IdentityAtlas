// Shared in-page sub-tab bar (used by the entity detail pages; reusable by the
// Admin sub-pages later). Interactive = blue per the UI Style Guide, dark-mode
// aware. Falsy entries in `tabs` are ignored so callers can express a
// conditional tab as `enabled && { key, label }`.
//
// Props:
//   tabs    [{ key, label, count? }]  — count renders as a muted suffix
//   active  string                     — key of the active tab
//   onChange (key) => void
export default function TabBar({ tabs, active, onChange }) {
  const visible = (tabs || []).filter(Boolean);
  return (
    <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700" role="tablist">
      {visible.map(({ key, label, count }) => {
        const isActive = key === active;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(key)}
            className={`pb-2 px-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
              isActive
                ? 'border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-300'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            {label}
            {count != null && (
              <span className="ml-1.5 text-xs text-gray-500 dark:text-gray-500">{count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
