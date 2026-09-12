// The one error panel the report surfaces use — the list, the report tab and a
// failed download all report trouble the same way, with an optional escape
// hatch back out of the tab.

export default function ReportError({ title, message, onClose }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-6 dark:border-red-700 dark:bg-red-900/30">
      <h3 className="font-semibold text-red-800 dark:text-red-300">{title}</h3>
      <p className="mt-1 text-sm text-red-600 dark:text-red-400">{message}</p>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="mt-3 text-sm text-gray-600 underline hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
        >
          Close
        </button>
      )}
    </div>
  );
}
