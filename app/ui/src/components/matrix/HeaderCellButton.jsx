import { FOCUS_RING } from '@ui/utils/keyActivate';

// Wraps the interactive content of a matrix header cell in a real <button> that
// fills the cell.
//
// A <th> can't itself become a button without losing its columnheader
// semantics, and these headers carry colSpan / sticky positioning that must stay
// on the <th>. So the cell keeps its markup and the button goes inside it. With
// no handler the children render bare, so a header that isn't actually clickable
// never gains a tab stop.
export default function HeaderCellButton({ onClick, title, label, className = '', children }) {
  if (!onClick) return children;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label}
      className={`w-full h-full cursor-pointer ${className} ${FOCUS_RING}`}
    >
      {children}
    </button>
  );
}
