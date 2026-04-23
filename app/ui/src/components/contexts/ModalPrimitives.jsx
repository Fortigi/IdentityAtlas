// Shared modal + form helpers used by every Contexts tab modal (create manual
// tree, run plugin, edit, etc.). Keeping them here so the visual language
// stays consistent and we don't duplicate the overlay / close-on-backdrop-click
// logic five times.

export function Modal({ title, subtitle, onClose, children, width = 480 }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/70" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-5 max-w-full max-h-[90vh] overflow-auto"
        style={{ width }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">{title}</h3>
            {subtitle && <p className="text-[11px] text-gray-500 dark:text-gray-400 dark:text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:text-gray-400 dark:text-gray-500 ml-4" aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, help, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">{label}</label>
      {children}
      {help && <p className="text-[11px] text-gray-500 dark:text-gray-400 dark:text-gray-500 mt-0.5">{help}</p>}
    </div>
  );
}

export function ErrorBox({ message }) {
  if (!message) return null;
  return (
    <div className="mt-3 text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded px-2 py-1">
      {message}
    </div>
  );
}

export function PrimaryButton({ onClick, disabled, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-3 py-1 text-xs rounded bg-blue-600 dark:bg-blue-700 text-white disabled:opacity-50 hover:bg-blue-700 dark:hover:bg-blue-600"
    >
      {children}
    </button>
  );
}

export function SecondaryButton({ onClick, disabled, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-3 py-1 text-xs rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300 disabled:opacity-50"
    >
      {children}
    </button>
  );
}
