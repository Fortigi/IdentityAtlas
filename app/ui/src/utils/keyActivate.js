// Keyboard activation helpers for controls that can't be a real <button>.
//
// Prefer a real <button>/<a> every time. Some places genuinely can't use one —
// a <button> is invalid inside <tr>, and a row that already contains checkboxes
// or link cells must not nest another interactive element. Those get
// `role="button"` + `tabIndex` + the `onKeyDown` handler built here, so Enter
// and Space activate them exactly like a native button does.
//
// Enforced by the `jsx-a11y/click-events-have-key-events` /
// `no-static-element-interactions` ESLint rules — a clickable element with no
// keyboard path fails the build.

// Native buttons activate on Enter and Space; nothing else.
const ACTIVATION_KEYS = ['Enter', ' '];

// The focus indicator every converted control carries. Blue is the interactive
// accent, and `focus-visible` keeps the ring off mouse clicks.
export const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

/**
 * Wrap a click handler as an onKeyDown handler.
 *
 * @param {Function} [handler] — the same function passed to onClick. When it is
 *   missing (an inert/non-clickable variant of the component) this returns
 *   `undefined`, so the element stays a plain non-interactive element.
 * @returns {Function|undefined} an onKeyDown handler.
 */
export function keyActivate(handler) {
  if (typeof handler !== 'function') return undefined;
  return (event) => {
    if (!ACTIVATION_KEYS.includes(event.key)) return;
    // Space scrolls the page and Enter can submit a surrounding form — a native
    // button suppresses both, so the stand-in must too.
    event.preventDefault();
    handler(event);
  };
}

/**
 * Every prop a non-button element needs to behave like a button.
 *
 * Use it for table rows and other elements where a real <button> is invalid or
 * would nest inside another control. Spread the result onto the element.
 *
 * @param {Function} [onActivate] — click/Enter/Space handler; omit to make the
 *   element inert (returns an empty object, so no stray role/tabIndex is left
 *   on a row that isn't actually clickable).
 * @param {object}  [opts]
 * @param {string}  [opts.label]    — accessible name, when the element's own
 *   text doesn't describe the action.
 * @param {boolean} [opts.expanded] — for rows that expand/collapse; emitted as
 *   `aria-expanded`.
 */
export function clickableRowProps(onActivate, { label, expanded } = {}) {
  if (typeof onActivate !== 'function') return {};
  return {
    role: 'button',
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: keyActivate(onActivate),
    ...(label === undefined ? {} : { 'aria-label': label }),
    ...(expanded === undefined ? {} : { 'aria-expanded': expanded }),
  };
}
