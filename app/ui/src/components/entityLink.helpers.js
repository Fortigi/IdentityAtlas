// The rules behind EntityLink.jsx, kept apart so that file exports components only.

export const NO_ACCESS_HINT = 'No access to details';

/** Whether a reference may open: there is a handler, an id, and the API did not refuse it (accessible !== false). Pure. */
export function canOpenRef({ id, accessible, onOpenDetail }) {
  return !!onOpenDetail && !!id && accessible !== false;
}
