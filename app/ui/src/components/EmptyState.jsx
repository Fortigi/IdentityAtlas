// Reusable empty / onboarding state. Standardises the "nothing here yet" panels
// that were previously hand-rolled (and inconsistent) across list pages, and
// lets each one offer a real next step instead of dead-ending the user.

export default function EmptyState({ title, hint, actionLabel, onAction, icon }) {
  return (
    <div className="border border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-10 text-center bg-white dark:bg-gray-800">
      {icon && <div className="mb-2 text-3xl" aria-hidden="true">{icon}</div>}
      <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200 mb-1">{title}</h3>
      {hint && <p className="mx-auto mb-4 max-w-xl text-sm text-gray-600 dark:text-gray-400">{hint}</p>}
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
