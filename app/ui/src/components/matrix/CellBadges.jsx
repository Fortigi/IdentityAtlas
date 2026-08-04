import { extraAccessTitle, missingAccessTitle, overGrantTitle } from './cellMarkers';

// The corner markers a matrix cell can carry. Colour is the whole language:
//
//   amber, on the left  — FEWER permissions than the business role assigns
//   red,   on the right — MORE permissions than the business role assigns
//
// A cell can carry both at once (a business role that grants several resources
// can be short in one and over in another for the same subject), so the two
// never share a corner. Kept out of MatrixCell so the aggregate (folded-column)
// cell in MatrixGroupRow renders exactly the same markers.

// Access a folded business role hides but does NOT grant — shown as a count on
// the folded role's own cell so folding can never quietly swallow the very
// thing a role-mining review is hunting for.
export function ExtraAccessBadge({ count }) {
  if (!count) return null;
  return (
    <span
      className="absolute -bottom-1 -right-1 flex items-center justify-center w-3 h-3 rounded-full text-[7px] font-bold leading-none bg-rose-600 text-white border border-rose-700 shadow-sm"
      style={{ zIndex: 2 }}
      title={extraAccessTitle(count)}
    >
      {count}
    </span>
  );
}

// The mirror: memberships a folded business role assigns that the subject does
// not have. Same idea, opposite direction — under-provisioning stays visible
// through the fold too.
export function MissingAccessBadge({ count }) {
  if (!count) return null;
  return (
    <span
      className="absolute -bottom-1 -left-1 flex items-center justify-center w-3 h-3 rounded-full text-[7px] font-bold leading-none bg-amber-500 text-white border border-amber-600 shadow-sm"
      style={{ zIndex: 2 }}
      title={missingAccessTitle(count)}
    >
      {count}
    </span>
  );
}

// A business role expects a membership this subject does not have.
function GapMarker() {
  return (
    <span
      className="absolute top-0 left-0 flex items-center justify-center w-2.5 h-2.5 rounded-full text-[6px] font-bold leading-none bg-amber-500 text-white border border-amber-600"
      style={{ zIndex: 2 }}
    >
      !
    </span>
  );
}

// The subject holds a standing membership where the role only grants
// just-in-time eligibility. Shares the bottom-right "more than the role
// assigns" corner with the folded-role count, which only ever appears on a
// folded role's own row — so the two never draw over each other.
function OverGrantMarker({ expected }) {
  return (
    <span
      className="absolute -bottom-1 -right-1 flex items-center justify-center w-3 h-3 rounded-full text-[7px] font-bold leading-none bg-rose-600 text-white border border-rose-700 shadow-sm"
      style={{ zIndex: 2 }}
      title={overGrantTitle(expected)}
    >
      +
    </span>
  );
}

// How many business roles cover this cell, when more than one does.
function ApCountBadge({ count }) {
  if (!(count > 1)) return null;
  return (
    <span
      className="absolute -top-1 -right-1 flex items-center justify-center w-3 h-3 rounded-full text-[7px] font-bold leading-none bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-500 shadow-sm"
      style={{ zIndex: 1 }}
    >
      {count}
    </span>
  );
}

export default function CellBadges({
  provisioningGap, overGrant, apCount, extraAccessCount, missingAccessCount,
}) {
  return (
    <>
      {provisioningGap && <GapMarker />}
      {overGrant && !extraAccessCount && <OverGrantMarker expected={overGrant} />}
      <ApCountBadge count={apCount} />
      <ExtraAccessBadge count={extraAccessCount} />
      <MissingAccessBadge count={missingAccessCount} />
    </>
  );
}
