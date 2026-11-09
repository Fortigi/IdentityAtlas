import { CATEGORY_META } from '@ui/utils/contextStyles';

// The template <select> shared by the new-context wizard and the manual
// editor: the four templates, each with its short description as the option
// title. `allowNone` adds an "Other (no template)" option for a context the
// backfill could not classify, so the editor can show — and keep — a null.
export default function ContextCategorySelect({ value, onChange, className = '', allowNone = false, ...rest }) {
  return (
    <select aria-label="Template" value={value ?? ''} onChange={e => onChange(e.target.value)} className={className} {...rest}>
      {allowNone && <option value="">Other (no template)</option>}
      {Object.entries(CATEGORY_META).map(([key, meta]) => (
        <option key={key} value={key} title={meta.description}>{meta.label}</option>
      ))}
    </select>
  );
}
