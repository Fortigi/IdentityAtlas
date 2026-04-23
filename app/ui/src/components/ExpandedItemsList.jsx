// ─── ExpandedItemsList ───────────────────────────────────────────────
// Generic list shown below the entity graph when a category has been
// drilled into. Every item the shape helper returns has the same
// shape — { key, label, kind: 'item', entityKind, entityId } — so one
// renderer works for every category click, regardless of whether it's
// users, resources, access packages, identities, contexts, or
// non-expandable leaves like policies/reviews/requests.
//
// Rows link to the corresponding entity detail tab when the entity
// kind has one; leaves just render the label.

const ENTITY_LABELS = {
  user:             'User',
  resource:         'Resource',
  'access-package': 'Business Role',
  identity:         'Identity',
  context:          'Context',
  leaf:             '',
};

const DETAIL_TARGET = {
  user:             'user',
  resource:         'resource',
  'access-package': 'access-package',
  identity:         'identity',
  context:          'context',
};

export default function ExpandedItemsList({ label, items, loading, onOpenDetail }) {
  if (loading && !items) {
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 text-center text-sm text-gray-500 dark:text-gray-400">
        Loading…
      </div>
    );
  }
  if (!items || items.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 text-center text-sm text-gray-400 dark:text-gray-500 italic">
        Nothing to show for this relationship.
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{label || 'Selected'}</h3>
        <span className="text-xs text-gray-500 dark:text-gray-400">{items.length}</span>
      </div>
      <div className="max-h-[460px] overflow-y-auto">
        <table className="w-full text-sm">
          <tbody>
            {items.map((it, i) => {
              const target = DETAIL_TARGET[it.entityKind];
              const typeLabel = ENTITY_LABELS[it.entityKind] || '';
              const clickable = target && !it.overflow && it.entityId;
              return (
                <tr key={it.key + ':' + i} className="border-b border-gray-50 dark:border-gray-700/50 last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-700/40">
                  <td className="px-4 py-2 align-top">
                    {clickable ? (
                      <button
                        onClick={() => onOpenDetail?.(target, it.entityId, it.label)}
                        className="text-blue-700 dark:text-blue-300 hover:text-blue-900 dark:hover:text-blue-100 hover:underline text-left font-medium"
                      >
                        {it.label}
                      </button>
                    ) : (
                      <span className="text-gray-900 dark:text-gray-100">{it.label}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {typeLabel}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
