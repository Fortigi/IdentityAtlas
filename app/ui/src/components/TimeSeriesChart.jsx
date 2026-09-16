// Minimal hand-rolled SVG line chart. No external dependency.
//
// One series per chart. Pass `data` as `[{ date: 'YYYY-MM-DD', value: number }]`
// already sorted ascending by date. The chart auto-fits Y to [yMin, yMax],
// rounding the axis to a sensible step.
//
// Two-point edge cases handled explicitly:
//   - 0 points → renders an empty-state message
//   - 1 point  → renders a single dot at the right edge
//
// Dark mode: uses CSS variables resolved at render time via the existing
// `useIsDark` hook so colors track the theme without re-rendering.

import { useMemo } from 'react';
import { useIsDark } from '@ui/contexts/ThemeContext';

const PADDING = { top: 16, right: 16, bottom: 28, left: 44 };

function formatTick(n) {
  if (n == null) return '';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 10_000)    return (n / 1_000).toFixed(0) + 'k';
  if (Math.abs(n) >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function formatDateLabel(dateStr) {
  // 'YYYY-MM-DD' → 'MMM d' (e.g. 'May 18')
  if (!dateStr) return '';
  const [, m, d] = dateStr.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}

// niceStep + ceilToStep produce axis-friendly bounds (e.g. 0..120 → 0..150,
// step 30) so the gridlines fall on round numbers.
function niceStep(range) {
  if (range <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(range)));
  const norm = range / pow;
  if (norm < 1.5) return 0.2 * pow;
  if (norm < 3)   return 0.5 * pow;
  if (norm < 7)   return 1.0 * pow;
  return 2.0 * pow;
}

// Optional title/subtitle block above the chart.
function ChartHeader({ title, subtitle }) {
  if (!title && !subtitle) return null;
  return (
    <div className="mb-1 px-1">
      {title    && <div className="text-sm font-medium text-gray-800 dark:text-gray-200">{title}</div>}
      {subtitle && <div className="text-xs text-gray-500 dark:text-gray-400">{subtitle}</div>}
    </div>
  );
}

// Centered message shown when there are no data points yet.
function ChartEmptyState({ empty, width, height, axisColor }) {
  if (!empty) return null;
  return (
    <text
      x={width / 2}
      y={height / 2}
      textAnchor="middle"
      fontSize={12}
      fill={axisColor}
    >
      No data yet — first snapshot writes on the next scheduler tick.
    </text>
  );
}

// The filled area, the line, and the last-point dot.
function ChartSeries({ empty, points, fillD, pathD, lineColor, fillColor, isDark }) {
  if (empty) return null;
  return (
    <>
      {points.length > 1 && (
        <path d={fillD} fill={fillColor} stroke="none" />
      )}
      {points.length > 1 && (
        <path
          d={pathD}
          fill="none"
          stroke={lineColor}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {/* Dot only on the last point — full-series dots get busy fast */}
      {points.length > 0 && (
        <circle
          cx={points[points.length - 1].x}
          cy={points[points.length - 1].y}
          r={3.5}
          fill={lineColor}
          stroke={isDark ? '#0f172a' : '#fff'}
          strokeWidth={2}
        />
      )}
    </>
  );
}

// Per-point hover affordance (transparent rects, tooltips via <title>).
function ChartHoverLayer({ empty, points, width, height, yFormat, yUnit }) {
  if (empty) return null;
  return points.map((p, i) => {
    const halfWidth = points.length > 1
      ? (points[1].x - points[0].x) / 2
      : 8;
    const rx = Math.max(p.x - halfWidth, PADDING.left);
    const rw = Math.min(halfWidth * 2, width - PADDING.right - rx);
    return (
      <g key={`hit-${i}`}>
        <rect
          x={rx}
          y={PADDING.top}
          width={rw}
          height={height - PADDING.top - PADDING.bottom}
          fill="transparent"
        >
          <title>{`${p.date}: ${yFormat(p.value)}${yUnit}`}</title>
        </rect>
      </g>
    );
  });
}

export default function TimeSeriesChart({
  data = [],
  height = 220,
  width = 560,
  color = '#3b82f6',
  yFormat = formatTick,
  yMin = null,         // pin floor (e.g. 0 for counts, 0 for percentages)
  yMax = null,         // pin ceiling (e.g. 100 for percentages)
  yUnit = '',          // appended to Y tick labels (e.g. '%')
  title = '',
  subtitle = '',
}) {
  const isDark = useIsDark();

  const gridColor = isDark ? '#374151' : '#e5e7eb';
  const axisColor = isDark ? '#9ca3af' : '#4b5563';
  const lineColor = color;
  const fillColor = color + '20';  // 12% opacity tint

  const { points, ticks, dateTicks } = useMemo(() => {
    const w = width  - PADDING.left - PADDING.right;
    const h = height - PADDING.top  - PADDING.bottom;

    if (!data || data.length === 0) {
      return { points: [], ticks: [], dateTicks: [] };
    }

    const values = data.map(d => Number(d.value) || 0);
    let dataMin = Math.min(...values);
    let dataMax = Math.max(...values);
    if (yMin !== null) dataMin = Math.min(dataMin, yMin);
    if (yMax !== null) dataMax = Math.max(dataMax, yMax);
    if (yMin !== null) dataMin = yMin;  // pin
    if (yMax !== null) dataMax = yMax;
    if (dataMax === dataMin) dataMax = dataMin + 1;

    const range = dataMax - dataMin;
    const step  = niceStep(range);
    const axisLo = yMin !== null ? yMin : Math.floor(dataMin / step) * step;
    const axisHi = yMax !== null ? yMax : Math.ceil (dataMax / step) * step;
    const axisRange = axisHi - axisLo || 1;

    const xAt = (i) => data.length <= 1
      ? PADDING.left + w
      : PADDING.left + (i / (data.length - 1)) * w;
    const yAt = (v) => PADDING.top + h - ((v - axisLo) / axisRange) * h;

    const points = data.map((d, i) => ({
      x: xAt(i),
      y: yAt(Number(d.value) || 0),
      date: d.date,
      value: Number(d.value) || 0,
    }));

    const ticks = [];
    for (let v = axisLo; v <= axisHi + 0.0001; v += step) {
      ticks.push({ value: v, y: yAt(v), label: yFormat(v) + yUnit });
    }

    // Sparse X-axis labels: first, last, and ~5 in between.
    const N = data.length;
    const idxs = N <= 6
      ? data.map((_, i) => i)
      : [0, Math.floor(N * 0.25), Math.floor(N * 0.5), Math.floor(N * 0.75), N - 1];
    const dateTicks = idxs.map(i => ({
      x: xAt(i),
      label: formatDateLabel(data[i].date),
    }));

    return { points, ticks, dateTicks };
  }, [data, width, height, yMin, yMax, yFormat, yUnit]);

  const pathD = useMemo(() => {
    if (points.length === 0) return '';
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  }, [points]);

  const fillD = useMemo(() => {
    if (points.length === 0) return '';
    const bottom = (height - PADDING.bottom).toFixed(1);
    const first = points[0], last = points[points.length - 1];
    return `M ${first.x.toFixed(1)} ${bottom} ` +
      points.map(p => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') +
      ` L ${last.x.toFixed(1)} ${bottom} Z`;
  }, [points, height]);

  const empty = data.length === 0;

  return (
    <div className="flex flex-col">
      <ChartHeader title={title} subtitle={subtitle} />
      <div className="relative w-full">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="w-full"
          style={{ height: `${height}px` }}
          role="img"
          aria-label={title || 'time series chart'}
        >
          {/* Y-axis gridlines + labels */}
          {ticks.map((t, i) => (
            <g key={`y-${i}`}>
              <line
                x1={PADDING.left}
                x2={width - PADDING.right}
                y1={t.y}
                y2={t.y}
                stroke={gridColor}
                strokeWidth={1}
                strokeDasharray={i === 0 ? '' : '3 3'}
              />
              <text
                x={PADDING.left - 6}
                y={t.y + 4}
                textAnchor="end"
                fontSize={10}
                fill={axisColor}
              >
                {t.label}
              </text>
            </g>
          ))}

          {/* X-axis labels */}
          {dateTicks.map((t, i) => (
            <text
              key={`x-${i}`}
              x={t.x}
              y={height - PADDING.bottom + 14}
              textAnchor="middle"
              fontSize={10}
              fill={axisColor}
            >
              {t.label}
            </text>
          ))}

          <ChartEmptyState empty={empty} width={width} height={height} axisColor={axisColor} />

          <ChartSeries
            empty={empty}
            points={points}
            fillD={fillD}
            pathD={pathD}
            lineColor={lineColor}
            fillColor={fillColor}
            isDark={isDark}
          />

          <ChartHoverLayer
            empty={empty}
            points={points}
            width={width}
            height={height}
            yFormat={yFormat}
            yUnit={yUnit}
          />

          {/* Axis lines */}
          <line
            x1={PADDING.left}
            x2={PADDING.left}
            y1={PADDING.top}
            y2={height - PADDING.bottom}
            stroke={gridColor}
            strokeWidth={1}
          />
          <line
            x1={PADDING.left}
            x2={width - PADDING.right}
            y1={height - PADDING.bottom}
            y2={height - PADDING.bottom}
            stroke={gridColor}
            strokeWidth={1}
          />
        </svg>
      </div>
    </div>
  );
}
