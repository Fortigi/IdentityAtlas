import { useState } from 'react';
import { TIER_STYLES } from '@ui/utils/tierStyles';

// Small risk-tier pill. Hidden for None/Minimal unless `showAll` is set.
export function TierBadge({ tier, showAll }) {
  if (!showAll && (!tier || tier === 'None' || tier === 'Minimal')) return null;
  const s = TIER_STYLES[tier] || TIER_STYLES.None;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${s.bg} ${s.text} ${s.border} border ${s.darkBg} ${s.darkText} ${s.darkBorder} whitespace-nowrap`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {tier}
    </span>
  );
}

// Circular avatar: the person's profile photo when we have one, otherwise
// their initial tinted by risk tier.
//
// `photo` is a data URI (the API base64-encodes the stored bytes) rather than
// a URL, because every API route needs the caller's bearer token and a plain
// <img src> cannot send one.
//
// `size` is a Tailwind class pair, not a number — the default 7 (28px) suits
// list rows; detail-page headers pass a larger one.
export function Avatar({ name, tier, photo, size = 'w-7 h-7' }) {
  // Which src failed, not whether one did. A photo that cannot be decoded
  // falls back to the initial rather than leaving a broken-image glyph — and
  // because the failure is tied to a specific src, a list row reused for the
  // next person recovers on its own. Tracking a plain boolean would need an
  // effect to reset it, and one bad image would poison that slot for everyone
  // shown in it afterwards.
  const [failedSrc, setFailedSrc] = useState(null);
  const style = TIER_STYLES[tier] || TIER_STYLES.None;

  if (photo && failedSrc !== photo) {
    return (
      <img
        src={photo}
        alt=""
        onError={() => setFailedSrc(photo)}
        className={`${size} rounded-full object-cover shrink-0 bg-gray-100 dark:bg-gray-700`}
      />
    );
  }

  return (
    <div
      className={`${size} rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0`}
      style={{ backgroundColor: style.avatar }}
    >
      {(name || '?')[0].toUpperCase()}
    </div>
  );
}
