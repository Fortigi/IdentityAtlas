import { barHeights, monthLabel, formatAmount } from './activity.helpers';

// A tiny per-month bar chart (inline SVG, no chart library): one bar per month
// of the period, scaled to the largest month of this row. The label carries the
// numbers for a screen reader; each bar has a tooltip.

const BAR = 5;
const GAP = 1;
const HEIGHT = 18;

export default function MonthBars({ perMonth, unit }) {
  if (!perMonth?.length) return null;
  const heights = barHeights(perMonth);
  const label = perMonth.map(p => `${monthLabel(p.month)} ${formatAmount(p.amount, unit)}`).join(', ');
  return (
    <svg role="img" aria-label={`Per month: ${label}`} width={perMonth.length * (BAR + GAP)} height={HEIGHT}
      className="inline-block align-middle text-blue-600 dark:text-blue-400">
      {perMonth.map((p, i) => {
        const h = Math.max(heights[i] * HEIGHT, p.amount > 0 ? 1 : 0);
        return (
          <rect key={p.month} x={i * (BAR + GAP)} y={HEIGHT - h} width={BAR} height={h} fill="currentColor">
            <title>{`${monthLabel(p.month)}: ${formatAmount(p.amount, unit)}`}</title>
          </rect>
        );
      })}
      <line x1="0" x2={perMonth.length * (BAR + GAP)} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} className="stroke-gray-300 dark:stroke-gray-600" strokeWidth="1" />
    </svg>
  );
}
