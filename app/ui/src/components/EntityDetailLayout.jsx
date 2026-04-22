import { friendlyLabel } from '../utils/formatters';
import { renderAttributeValue } from '../utils/renderAttribute';

// ─── EntityDetailLayout ────────────────────────────────────────────────
// Two-column layout shared by User/Identity/Resource detail pages.
// Left  — a single "Attributes" table (real + extended attributes merged).
// Right — graph + the expandable relationship list below it.
//
// Children are rendered in order below both columns for risk score, history,
// and any entity-specific sections.

export default function EntityDetailLayout({ left, right, children }) {
  return (
    <div className="max-w-7xl mx-auto">
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-2 min-w-0">{left}</div>
        <div className="lg:col-span-3 min-w-0">{right}</div>
      </div>
      {children && <div className="mt-6 space-y-6">{children}</div>}
    </div>
  );
}

// ─── AttributesTable ───────────────────────────────────────────────────
// Renders the unified attribute list (core columns + extendedAttributes)
// as a single label|value table. Caller supplies the already-merged
// entries so this component stays presentation-only.
//
// entries: [ [label, value, meta?] ]   meta.extended=true shows a faded
// "ext" tag so readers can still distinguish JSON-derived fields.

export function AttributesTable({ title = 'Attributes', entries }) {
  const visible = entries.filter(([, v]) => v != null && v !== '');
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{title}</h3>
        <span className="text-xs text-gray-500 dark:text-gray-400">{visible.length}</span>
      </div>
      {visible.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-500 italic p-4">No attributes</p>
      ) : (
        <div className="max-h-[560px] overflow-y-auto">
          <table className="w-full text-sm">
            <tbody>
              {visible.map(([key, val, meta]) => (
                <tr key={key} className="border-b border-gray-50 dark:border-gray-700/50 last:border-b-0 hover:bg-gray-50/50 dark:hover:bg-gray-700/30">
                  <td className="py-1.5 pl-4 pr-3 text-gray-500 dark:text-gray-400 whitespace-nowrap align-top w-1/3">
                    <span className="flex items-center gap-1.5">
                      {friendlyLabel(key)}
                      {meta?.extended && (
                        <span className="inline-block px-1 py-0 rounded text-[9px] font-mono text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600" title="From extendedAttributes">ext</span>
                      )}
                    </span>
                  </td>
                  <td className="py-1.5 pr-4 text-gray-900 dark:text-gray-100 font-medium break-all align-top">
                    {typeof val === 'object' && !Array.isArray(val) && !(val && val.props)
                      ? <span className="text-gray-600 dark:text-gray-300 font-mono text-xs">{JSON.stringify(val)}</span>
                      : renderAttributeValue(key, val)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Helper: merge real attributes + extendedAttributes into a flat list ─
// Real columns first, then a visual separator, then extended-attribute keys.
// Hidden set is the caller's HIDDEN_FIELDS (header/risk fields etc.).

export function buildAttributeEntries(attributes, extendedAttributes, hiddenKeys) {
  const hide = hiddenKeys instanceof Set ? hiddenKeys : new Set(hiddenKeys || []);
  const core = Object.entries(attributes || {})
    .filter(([k, v]) => !hide.has(k) && v != null && v !== '');
  // Put id first if present
  core.sort((a, b) => (a[0] === 'id' ? -1 : b[0] === 'id' ? 1 : 0));

  const extended = Object.entries(extendedAttributes || {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => [k, v, { extended: true }]);

  return [...core, ...extended];
}
