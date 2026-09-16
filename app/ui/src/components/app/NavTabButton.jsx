// One primary navigation tab in the app header.
export default function NavTabButton({ tab, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium rounded-t-lg border border-b-0 transition-colors whitespace-nowrap ${
        active
          ? 'bg-gray-50 dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-gray-200 dark:border-gray-600'
          : 'bg-transparent text-gray-500 dark:text-gray-400 border-transparent hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50'
      }`}
    >
      {tab.label}
    </button>
  );
}
