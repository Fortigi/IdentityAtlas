// Pure title/background derivation for a single matrix cell. Kept out of the
// component so the branchy tooltip wording stays testable in isolation.

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

// Derives the cell tooltip and background colour from its state. Managed cells
// carry the AP colour; unmanaged cells stay white.
export function describeCell({ hasMembership, membershipTypes, managed, apColor, apNames, provisioningGap, gapExpected }) {
  const managedBg = apColor || MANAGED_BG_FALLBACK;
  if (hasMembership) {
    return {
      title: membershipTitle({ membershipTypes, managed, apNames, provisioningGap, gapExpected }),
      bgColor: managed ? managedBg : undefined,
    };
  }
  if (provisioningGap) {
    return { title: gapOnlyTitle({ apNames, gapExpected }), bgColor: managedBg };
  }
  return { title: undefined, bgColor: undefined };
}
