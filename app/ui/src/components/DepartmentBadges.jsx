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

// Circular initial avatar tinted by the person's risk tier.
export function Avatar({ name, tier }) {
  const letter = (name || '?')[0].toUpperCase();
  const style = TIER_STYLES[tier] || TIER_STYLES.None;
  return (
    <div
      className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0"
      style={{ backgroundColor: style.avatar }}
    >
      {letter}
    </div>
  );
}
