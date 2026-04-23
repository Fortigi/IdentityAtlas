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
        <div>
          {/* table-fixed + a hard column width on the label keeps a long
              extensionAttribute_<32-hex>_<key> label from blowing the
              label column past 1/3 and squeezing the value column down
              to ~10px (which made values wrap one character per line).
              No max-height: let the panel grow as long as the data needs.
              Page-level scrolling beats table-level scrolling for long
              attribute lists with extension keys. */}
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col className="w-[40%]" />
              <col className="w-[60%]" />
            </colgroup>
            <tbody>
              {visible.map(([key, val, meta]) => (
                <tr key={key} className="border-b border-gray-50 dark:border-gray-700/50 last:border-b-0 hover:bg-gray-50/50 dark:hover:bg-gray-700/30">
                  <td className="py-1.5 pl-4 pr-3 text-gray-500 dark:text-gray-400 align-top break-words">
                    <span className="inline-flex items-start gap-1.5">
                      <span className="break-all">{friendlyLabel(key)}</span>
                      {meta?.extended && (
                        <span className="inline-block px-1 py-0 rounded text-[9px] font-mono text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 shrink-0" title="From extendedAttributes">ext</span>
                      )}
                    </span>
                  </td>
                  <td className="py-1.5 pr-4 text-gray-900 dark:text-gray-100 font-medium align-top break-words">
                    {typeof val === 'object' && !Array.isArray(val) && !(val && val.props)
                      ? <span className="text-gray-600 dark:text-gray-300 font-mono text-xs break-all">{JSON.stringify(val)}</span>
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
