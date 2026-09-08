import { FOCUS_RING } from '@ui/utils/keyActivate';

// The entity-name cell of a list row: a real <button> styled as a link, so the
// name is reachable by Tab and opens the detail tab on Enter/Space. The <td>
// keeps the padding, and the click stops at the button so the row's own
// select-on-click doesn't also fire.
export default function EntityLinkCell({ onOpen, title, children }) {
  return (
    <td className="px-3 py-2 font-medium">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpen?.(); }}
        title={title}
        className={`text-left text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 hover:underline cursor-pointer rounded ${FOCUS_RING}`}
      >
        {children}
      </button>
    </td>
  );
}
