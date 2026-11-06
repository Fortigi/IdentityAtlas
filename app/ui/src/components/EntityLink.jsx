// A reference to another object — a link when the reader may open it, plain
// text when not.
//
// The API decides who may open what. For a context owner (ContextOwnerPage) it
// marks every referenced object in its responses with `accessible: true|false`
// (app/api/src/auth/ownerAccess, docs/architecture/context-owner-access.md);
// for every other reader the field is absent and everything stays a link. So a
// component never decides on its own: it hands the flag through.
//
// Facts are never hidden: an object the reader may not open is still named, in
// a lighter colour, with "No access to details" as its hint (title for the
// mouse, a visually hidden suffix for a screen reader).

import { NO_ACCESS_HINT, canOpenRef } from './entityLink.helpers';

const LINK = 'text-left font-medium text-blue-700 hover:underline dark:text-blue-300';
const NO_ACCESS = 'text-gray-500 dark:text-gray-400';

/** The name of an object the reader may not open: lighter, with the hint. */
export function NoAccessName({ label, className = '' }) {
  return (
    <span className={`${NO_ACCESS} ${className}`.trim()} title={NO_ACCESS_HINT} data-testid="no-access-ref">
      {label}
      <span className="sr-only"> ({NO_ACCESS_HINT.toLowerCase()})</span>
    </span>
  );
}

/**
 * kind, id, label — what to open and how it reads; accessible — the API's flag
 * (absent = open); onOpenDetail(kind, id, label) — the page's opener.
 * className styles the link, plainClassName the text when there is nothing to
 * open (no handler or no id).
 */
export default function EntityLink({ kind, id, label, accessible, onOpenDetail, className = LINK, plainClassName = '' }) {
  if (accessible === false) return <NoAccessName label={label} />;
  if (!canOpenRef({ id, accessible, onOpenDetail })) return <span className={plainClassName || undefined}>{label}</span>;
  return (
    <button type="button" onClick={() => onOpenDetail(kind, id, label)} className={className}>
      {label}
    </button>
  );
}

/**
 * A small "Open" button beside a name whose own click does something else (a
 * member row's references toggle). Nothing when the object may not open.
 */
export function OpenDetailsButton({ kind, id, name, accessible, onOpenDetail }) {
  if (!canOpenRef({ id, accessible, onOpenDetail })) return null;
  return (
    <button type="button" onClick={() => onOpenDetail(kind, id, name)} aria-label={`Open ${name}`}
      className="ml-2 rounded border border-blue-200 px-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-900/30">
      Open
    </button>
  );
}
