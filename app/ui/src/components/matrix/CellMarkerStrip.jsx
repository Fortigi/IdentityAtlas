import {
  extraAccessTitle, missingAccessTitle, overGrantTitle, heldOutsideTitle, hasCellMarkers,
} from './cellMarkers';

// Every marker an intersection cell can carry is drawn here, in ONE strip along
// the top of the cell, above the D/I/E badge — see cellMarkers.js for the
// geometry that reserves the strip and for why the markers left the corners.

function Marker({ className, title, children }) {
  return (
    <span
      className={`flex h-2 w-2 items-center justify-center rounded-full text-[7px] font-bold leading-none ${className}`}
      title={title}
    >
      {children}
    </span>
  );
}

// Keeps the three slots in place when a cell carries only some of them.
function EmptySlot() {
  return <span className="h-2 w-2" aria-hidden="true" />;
}

// Fewer than the business role assigns: the provisioning gap on a resource's
// own cell, or — on a folded role — how many of the folded resources the role
// assigns this subject does not have. One amber slot, one meaning.
function FewerMarker({ provisioningGap, missingAccessCount }) {
  if (missingAccessCount > 0) {
    return (
      <Marker className="bg-amber-500 text-white" title={missingAccessTitle(missingAccessCount)}>
        {missingAccessCount}
      </Marker>
    );
  }
  if (provisioningGap) return <Marker className="bg-amber-500 text-white">!</Marker>;
  return <EmptySlot />;
}

// More than the business role assigns: a standing membership where the role
// only grants eligibility, a membership held outside the role that grants the
// resource at all, or — on a folded role — how many of the folded resources this
// subject holds outside it. The folded count wins the slot when both apply; the
// cell tooltip still explains both.
function MoreMarker({ overGrant, extraAccessCount, heldOutsideCount, heldOutsideNames }) {
  if (extraAccessCount > 0) {
    return (
      <Marker className="bg-rose-600 text-white" title={extraAccessTitle(extraAccessCount)}>
        {extraAccessCount}
      </Marker>
    );
  }
  if (overGrant) {
    return <Marker className="bg-rose-600 text-white" title={overGrantTitle(overGrant)}>+</Marker>;
  }
  if (heldOutsideCount > 0) {
    return (
      <Marker
        className="bg-rose-600 text-white"
        title={heldOutsideTitle(heldOutsideCount, heldOutsideNames)}
      >
        {heldOutsideCount}
      </Marker>
    );
  }
  return <EmptySlot />;
}

// How many business roles cover this cell, when more than one does. The cell's
// own tooltip names them ("Managed by: …").
function RoleCountMarker({ apCount }) {
  if (!(apCount > 1)) return <EmptySlot />;
  return (
    <Marker className="bg-white text-gray-700 border border-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:border-gray-500">
      {apCount}
    </Marker>
  );
}

export default function CellMarkerStrip({
  provisioningGap, overGrant, apCount, extraAccessCount, missingAccessCount,
  heldOutsideCount, heldOutsideNames,
}) {
  if (!hasCellMarkers({
    apCount, provisioningGap, overGrant, extraAccessCount, missingAccessCount, heldOutsideCount,
  })) {
    return null;
  }
  return (
    <span className="absolute inset-x-0 top-0 flex h-2 items-center justify-between">
      <FewerMarker provisioningGap={provisioningGap} missingAccessCount={missingAccessCount} />
      <RoleCountMarker apCount={apCount} />
      <MoreMarker
        overGrant={overGrant}
        extraAccessCount={extraAccessCount}
        heldOutsideCount={heldOutsideCount}
        heldOutsideNames={heldOutsideNames}
      />
    </span>
  );
}
