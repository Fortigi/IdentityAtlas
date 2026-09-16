// Pure title/background derivation for a single matrix cell. Kept out of the
// component so the branchy tooltip wording stays testable in isolation.

import {
  extraAccessTitle, missingAccessTitle, overGrantTitle, heldOutsideTitle,
} from './cellMarkers';

const MANAGED_BG_FALLBACK = '#dbeafe';

// Tooltip when the subject actually holds one or more membership types.
function membershipTitle({ membershipTypes, managed, apNames, provisioningGap, gapExpected }) {
  const types = [...membershipTypes].join(', ');
  let title;
  if (apNames && apNames.length > 0) {
    title = `${types}\nManaged by: ${apNames.join(', ')}`;
  } else if (managed) {
    title = `${types} (managed by business role)`;
  } else {
    title = types;
  }
  if (provisioningGap) {
    const expectedLabel = gapExpected ? ` (expects ${gapExpected})` : '';
    title += `\n⚠ Provisioning gap: user lacks the membership type specified by the business role${expectedLabel}`;
  }
  return title;
}

// Tooltip when an access package manages the cell but the subject has no membership.
function gapOnlyTitle({ apNames, gapExpected }) {
  const expectedLabel = gapExpected ? ` ${gapExpected}` : '';
  let title = `⚠ Provisioning gap: business role expects${expectedLabel} membership but user has none`;
  if (apNames && apNames.length > 0) {
    title += `\nManaged by: ${apNames.join(', ')}`;
  }
  return title;
}

// The marker lines, appended to whatever the cell already says about how the
// access is held. Each marker in the strip explains itself on hover, but the
// cell's own tooltip has to carry all of them: only one marker can win the red
// slot, and the reader must still be told about the other.
function markerLines({ overGrant, extraAccessCount, missingAccessCount, heldOutsideCount, heldOutsideNames, heldOutsideHoldsRole }) {
  const lines = [];
  if (overGrant) lines.push(overGrantTitle(overGrant));
  if (extraAccessCount > 0) lines.push(extraAccessTitle(extraAccessCount));
  if (missingAccessCount > 0) lines.push(missingAccessTitle(missingAccessCount));
  if (heldOutsideCount > 0) lines.push(heldOutsideTitle(heldOutsideCount, heldOutsideNames, heldOutsideHoldsRole));
  return lines;
}

// Joins the base tooltip with the marker lines. Either half can be absent — an
// empty cell under a folded role has markers and nothing else to say.
function joinTitle(base, markers) {
  const parts = [base, ...markers].filter(Boolean);
  return parts.length ? parts.join('\n') : undefined;
}

// Derives the cell tooltip and background colour from its state. Managed cells
// carry the AP colour; unmanaged cells stay white.
export function describeCell({
  hasMembership, membershipTypes, managed, apColor, apNames, provisioningGap, gapExpected,
  overGrant = null, extraAccessCount = 0, missingAccessCount = 0,
  heldOutsideCount = 0, heldOutsideNames = null, heldOutsideHoldsRole = false,
}) {
  const managedBg = apColor || MANAGED_BG_FALLBACK;
  const markers = markerLines({
    overGrant, extraAccessCount, missingAccessCount, heldOutsideCount, heldOutsideNames,
    heldOutsideHoldsRole,
  });
  if (hasMembership) {
    return {
      title: joinTitle(membershipTitle({ membershipTypes, managed, apNames, provisioningGap, gapExpected }), markers),
      bgColor: managed ? managedBg : undefined,
    };
  }
  if (provisioningGap) {
    return { title: joinTitle(gapOnlyTitle({ apNames, gapExpected }), markers), bgColor: managedBg };
  }
  return { title: joinTitle(undefined, markers), bgColor: undefined };
}
