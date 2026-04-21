// Shared modal + form helpers used by every Contexts tab modal (create manual
// tree, run plugin, edit, etc.). Keeping them here so the visual language
// stays consistent and we don't duplicate the overlay / close-on-backdrop-click
// logic five times.

export function Modal({ title, subtitle, onClose, children, width = 480 }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white border border-gray-200 rounded-lg shadow-xl p-5 max-w-full max-h-[90vh] overflow-auto"
        style={{ width }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-900 truncate">{title}</h3>
            {subtitle && <p className="text-[11px] text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 ml-4" aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, help, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700">{label}</label>
      {children}
      {help && <p className="text-[11px] text-gray-500 mt-0.5">{help}</p>}
    </div>
  );
}

export function ErrorBox({ message }) {
  if (!message) return null;
  return (
    <div className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
      {message}
    </div>
  );
}

export function PrimaryButton({ onClick, disabled, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-3 py-1 text-xs rounded bg-blue-600 text-white disabled:opacity-50 hover:bg-blue-700"
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
      className="px-3 py-1 text-xs rounded border border-gray-200 bg-white hover:bg-gray-50 text-gray-700 disabled:opacity-50"
    >
      {children}
    </button>
  );
}
