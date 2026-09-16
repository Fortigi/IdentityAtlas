import { tabBadge } from '@ui/utils/tabBadge';
import { detailTabIconBg } from '@ui/App.helpers';

// One dynamic detail tab (#user:id, #resource:id, …) in the app header nav,
// with its type badge and a hover-revealed close button.
export default function DetailTab({ tab, active, onSelect, onClose }) {
  const icon = tabBadge(tab.type);
  const iconBg = detailTabIconBg(tab.type);
  return (
    <button
      onClick={onSelect}
      className={`group flex items-center gap-1.5 pl-2 pr-1 py-2 text-sm font-medium rounded-t-lg border border-b-0 transition-colors whitespace-nowrap max-w-[200px] ${
        active
          ? 'bg-gray-50 dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-gray-200 dark:border-gray-600'
          : 'bg-transparent text-gray-500 dark:text-gray-400 border-transparent hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50'
      }`}
    >
      <span className={`inline-flex items-center justify-center w-4 h-4 rounded-sm text-[9px] font-bold ${iconBg}`}>{icon}</span>
      <span className="truncate max-w-[140px]">{tab.displayName}</span>
      <span
        onClick={(e) => { e.stopPropagation(); onClose(tab.type, tab.id); }}
        className="ml-0.5 p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity"
        title="Close"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </span>
    </button>
  );
}
