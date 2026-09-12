// Shared Admin UI primitives — extracted from AdminPage.jsx so the section
// components can share them without a monolith. Pure presentational helpers;
// the action behind FeatureToggleCard's switch is @ui/hooks/useFeatureToggle.
import { useState } from 'react';

export function MetaBadge({ label, value }) {
  if (!value) return null;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs">
      <span className="text-gray-600 dark:text-gray-500">{label}:</span>
      <span className="font-medium">{value}</span>
    </span>
  );
}

export function JsonViewer({ data }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
      >
        <svg className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        {open ? 'Hide' : 'Show'} raw JSON
      </button>
      {open && (
        <pre className="mt-2 p-3 bg-gray-900 text-gray-100 text-xs rounded-lg overflow-auto max-h-96 leading-relaxed">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function Section({ title, icon, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-lg">{icon}</span>
          <span className="font-medium text-gray-900 dark:text-white">{title}</span>
        </div>
        <svg className={`w-4 h-4 text-gray-600 dark:text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="px-5 pb-5 pt-0 border-t border-gray-100 dark:border-gray-700">{children}</div>}
    </div>
  );
}

// A feature-flag card: title, explanation, and the on/off switch that POSTs to
// /api/admin/features/toggle. Shared by every admin tab that owns a flag (Risk
// Scoring, Experimental) so the switch looks and behaves identically everywhere.
// `busy` disables the switch mid-request; `disabled` covers "flags not loaded yet".
export function FeatureToggleCard({ title, enabled, busy, disabled, onToggle, toggleTitle, children }) {
  return (
    <div className={`rounded-lg border p-5 ${enabled ? 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700' : 'bg-gray-50 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600'}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-white">{title}</h3>
          {children}
        </div>
        <div className="flex-shrink-0">
          <button
            onClick={onToggle}
            disabled={busy || disabled}
            role="switch"
            aria-checked={enabled}
            aria-label={title}
            className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
              enabled ? 'bg-emerald-600' : 'bg-gray-300 dark:bg-gray-600'
            } disabled:opacity-50`}
            title={toggleTitle}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
          <div className="text-xs text-gray-500 dark:text-gray-400 text-center mt-1">
            {busy ? '...' : enabled ? 'Enabled' : 'Disabled'}
          </div>
        </div>
      </div>
    </div>
  );
}

export function NotConfigured({ message }) {
  return (
    <div className="mt-4 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-500">
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      {message}
    </div>
  );
}

export function ResultRow({ label, value, good, warn, bad }) {
  const color = bad ? 'text-red-600 dark:text-red-400' : warn ? 'text-amber-600 dark:text-amber-400' : good && value > 0 ? 'text-green-700 dark:text-green-400' : 'text-gray-600 dark:text-gray-400';
  return (
    <div className="flex justify-between">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <span className={`font-semibold ${color}`}>{value}</span>
    </div>
  );
}
