import { FOCUS_RING } from '@ui/utils/keyActivate';

// A toggle chip that filters a list — tags on the entity list pages, categories
// on the business-roles page.
//
// The chip is two real buttons inside a decorative <span>, not one clickable
// <span>: buttons can't nest, so the "filter by this" toggle and the "delete
// this tag" ✕ have to be siblings. Between them they cover the whole chip, so
// the pointer target is unchanged while both actions become keyboard-reachable.
// `aria-pressed` is what tells a screen reader the filter is currently on.
export default function FilterPill({
  active,
  onToggle,
  title,
  style,
  className = '',
  onDelete,
  deleteLabel,
  children,
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full text-xs font-medium border ${
        active ? 'ring-2 ring-offset-1 ring-blue-400' : 'hover:opacity-80'
      } ${className}`}
      style={style}
    >
      <button
        type="button"
        onClick={onToggle}
        title={title}
        aria-pressed={!!active}
        className={`inline-flex items-center gap-1 py-0.5 pl-2 cursor-pointer rounded-full ${onDelete ? 'pr-1' : 'pr-2'} ${FOCUS_RING}`}
      >
        {children}
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={deleteLabel}
          title={deleteLabel}
          className={`py-0.5 pl-0.5 pr-2 rounded-full opacity-50 hover:opacity-100 ${FOCUS_RING}`}
        >
          &times;
        </button>
      )}
    </span>
  );
}
