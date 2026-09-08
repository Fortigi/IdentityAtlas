import { FOCUS_RING } from '@ui/utils/keyActivate';

// The rotated (bottom-to-top) column label used across the matrix headers —
// subject names, access-package names, resource names, business roles.
//
// It has to be a real <button> so it is reachable by Tab, and the rotation has
// to survive that swap: the vertical writing mode lives in inline styles the
// button inherits, and the three resets below undo the differences between a
// <button> box and the <div> this replaced (buttons are inline-block and
// centre their text). Visual parity with the old markup is deliberate.
const ROTATED = {
  writingMode: 'vertical-lr',
  textOrientation: 'mixed',
  transform: 'rotate(180deg)',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  display: 'block',
  textAlign: 'start',
  margin: '0 auto',
};

export default function RotatedLabelButton({ onClick, title, className = '', style, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`cursor-pointer ${className} ${FOCUS_RING}`}
      style={{ ...ROTATED, ...style }}
    >
      {children}
    </button>
  );
}
