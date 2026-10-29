// "Include deleted" checkbox for list pages over soft-deleted entities
// (migration 040). Checked → the list also shows rows deleted in the source.
// `noun` fills the tooltip, e.g. "business roles".
export default function IncludeDeletedToggle({ checked, onChange, noun = 'items' }) {
  return (
    <label
      className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-pointer select-none"
      title={`Also show ${noun} that were deleted in the source system`}
    >
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      Include deleted
    </label>
  );
}
