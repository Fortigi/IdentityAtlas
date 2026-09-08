// The dark overlay behind a modal, plus the panel that sits on it. Clicking the
// overlay dismisses (when `onDismiss` is supplied); a click inside the panel
// stops there, so it doesn't also close the modal.
//
// This is the one place in the app that carries a `jsx-a11y` disable for a
// clickable non-control, and it is deliberate: a backdrop must NOT become a
// button. It has no accessible name, it isn't an action a user navigates to,
// and making it focusable would put a phantom control in the tab order of every
// modal. The keyboard path for a modal is Escape plus a focus trap, which is the
// shared-dialog work tracked in #752 — this component is where that will land.
//
// Every modal overlay in the app goes through here, so there is exactly one
// disable to audit rather than five.
export default function ModalBackdrop({
  onDismiss,
  className,
  panelClassName,
  panelStyle,
  children,
}) {
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop dismiss; keyboard path (Escape + focus trap) lands in #752. See the note above.
    <div className={className} onClick={onDismiss}>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- stopPropagation guard only: keeps a click inside the panel from reaching the backdrop. Not user-interactive. */}
      <div className={panelClassName} style={panelStyle} onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
