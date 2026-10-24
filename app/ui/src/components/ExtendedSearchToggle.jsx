import { MIN_EXTENDED_SEARCH_LENGTH } from '@ui/utils/matchedOn';

// "All attributes" next to a list's search box: search every value a source
// sent (a phone number, a CMDB reference, an HR number) instead of only the
// name and ids. Shared by the entity list pages and the Contexts pane.
export default function ExtendedSearchToggle({ checked, onChange, className = '' }) {
  return (
    <label
      className={`flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-pointer select-none ${className}`}
      title={`Also search every attribute — phone numbers, CMDB references, HR numbers and anything else a source sends. Needs at least ${MIN_EXTENDED_SEARCH_LENGTH} characters.`}
    >
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      All attributes
    </label>
  );
}
