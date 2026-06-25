// Small "Deleted" pill for soft-deleted (tombstoned) entities and historical
// (deleted-endpoint) assignment rows. Title carries the deletion time when known.
export default function DeletedBadge({ at = null, label = 'Deleted', className = '' }) {
  let title = 'No longer present in the source system';
  if (at) {
    try { title = `Deleted ${new Date(at).toLocaleString()}`; } catch { /* keep default */ }
  }
  return (
    <span
      title={title}
      className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium align-middle bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 ${className}`}
    >
      {label}
    </span>
  );
}
