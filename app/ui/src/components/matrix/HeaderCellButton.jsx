import { FOCUS_RING } from '@ui/utils/keyActivate';

// Wraps the interactive content of a matrix header cell in a real <button> that
// fills the cell.
//
// A <th> can't itself become a button without losing its columnheader
// semantics, and these headers carry colSpan / sticky positioning / the cell
// tooltip that must stay on the <th>. So the cell keeps its markup and the
// button goes inside it. With no handler the children render bare, so a header
// that isn't actually clickable never gains a tab stop.
//
// The <th> keeps its own onClick as a redundant pointer shortcut. These header
// cells are as narrow as 24px and several have no fixed height for `h-full` to
// resolve against, so a button that only covers its own text would shrink the
// mouse target that the matrix has always had. That makes a pointer click on
// the button bubble into a second call, hence the stopPropagation below — this
// button is the keyboard path to the same action, not a second action.
export default function HeaderCellButton({ onClick, title, label, className = '', children }) {
  if (!onClick) return children;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      title={title}
      aria-label={label}
      className={`w-full h-full cursor-pointer ${className} ${FOCUS_RING}`}
    >
      {children}
    </button>
  );
}
