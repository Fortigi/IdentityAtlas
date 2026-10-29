// The summary above a list report's table: the charts and pivots the template
// declares, drawn on screen instead of only inside the xlsx download.
//
// Report-agnostic like the rest of this folder — it reads the declarations and
// the column labels from the response and knows no report by name. Every slice
// and every group is a button that filters the table below to its rows, so the
// summary is the way into the list rather than a picture beside it.

import { useMemo, useState } from 'react';
import TabBar from '@ui/components/TabBar';
import { chartSeries, pivotGroups, sliceColor, xlsxKinds } from './summaryData';

/** Groups shown per level of a pivot; the rest are counted, not drawn. */
export const MAX_GROUPS = 50;

const fmt = value => value.toLocaleString('en-US');
const labelFor = (columns, key) => columns.find(c => c.key === key)?.label || key;
const sameFilter = (a, b) => a.length === b.length
  && a.every((c, i) => c.key === b[i].key && c.label === b[i].label);

export default function ReportSummary({ report, filter, onFilter }) {
  const columns = report.columns || [];
  const rows = report.rows || [];
  const charts = (report.charts || []).filter(c => c?.category);
  const pivots = (report.pivots || []).filter(p => p?.rows?.length);
  const [tab, setTab] = useState(0);
  if (rows.length === 0 || (!charts.length && !pivots.length)) return null;

  const active = Math.min(tab, pivots.length - 1);
  const toggle = next => onFilter(sameFilter(filter, next) ? [] : next);
  const offersXlsx = (report.exportFormats || []).includes('xlsx');

  return (
    <section aria-label="Summary" className="mb-4 space-y-3">
      {charts.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {charts.map(chart => (
            <ChartCard key={chart.name || chart.category} chart={chart} rows={rows} columns={columns}
              filter={filter} onToggle={toggle} />
          ))}
        </div>
      )}
      {pivots.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
          {pivots.length > 1 && (
            <div className="px-3 pt-2">
              <TabBar tabs={pivots.map((p, i) => ({ key: String(i), label: p.name }))}
                active={String(active)} onChange={key => setTab(Number(key))} />
            </div>
          )}
          <PivotTable key={pivots[active].name} pivot={pivots[active]} rows={rows} columns={columns}
            filter={filter} onToggle={toggle} />
        </div>
      )}
      {offersXlsx && (
        <p className="text-xs text-gray-600 dark:text-gray-400">
          The XLSX download has these as Excel {xlsxKinds(pivots, charts)} you can rearrange, next to the full data.
        </p>
      )}
    </section>
  );
}

// One chart: a bar split by share, and a legend whose entries filter the table.
function ChartCard({ chart, rows, columns, filter, onToggle }) {
  const series = useMemo(() => chartSeries(chart, rows), [chart, rows]);
  const title = chart.title || chart.name || labelFor(columns, chart.category);
  return (
    <figure aria-label={title} className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
      <figcaption className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-gray-900 dark:text-white">{title}</span>
        {chart.valueLabel && <span className="text-xs text-gray-600 dark:text-gray-400">{chart.valueLabel}</span>}
      </figcaption>
      <div className="flex h-3 w-full overflow-hidden rounded bg-gray-100 dark:bg-gray-700" aria-hidden="true">
        {series.map((s, i) => (
          <span key={s.label} title={s.label} style={{ width: `${s.share * 100}%`, backgroundColor: sliceColor(chart, s.label, i) }} />
        ))}
      </div>
      <ul className="mt-2 space-y-0.5 text-sm">
        {series.map((s, i) => {
          const next = [{ key: chart.category, label: s.label }];
          return (
            <li key={s.label}>
              <button type="button" aria-pressed={sameFilter(filter, next)} onClick={() => onToggle(next)}
                className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-gray-100 aria-pressed:bg-blue-50 dark:hover:bg-gray-700 dark:aria-pressed:bg-blue-900/30">
                <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: sliceColor(chart, s.label, i) }} />
                <span className="flex-1 truncate text-gray-700 dark:text-gray-300">{s.label}</span>
                <span className="tabular-nums text-gray-900 dark:text-gray-100">{fmt(s.value)}</span>
                <span className="w-10 text-right tabular-nums text-gray-600 dark:text-gray-400">{Math.round(s.share * 100)}%</span>
              </button>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

// One pivot as a grouped table: a row per group with its row count and the sum
// of each value column, expandable to the next level of the pivot's rows.
function PivotTable({ pivot, rows, columns, filter, onToggle }) {
  const groups = useMemo(() => pivotGroups(pivot, rows), [pivot, rows]);
  const [expanded, setExpanded] = useState(() => new Set());
  const values = pivot.values || [];
  const flip = id => setExpanded((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <caption className="sr-only">{pivot.name}</caption>
        <thead className="bg-gray-50 dark:bg-gray-700/50">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-medium text-gray-600 dark:text-gray-300">
              {pivot.rows.map(k => labelFor(columns, k)).join(' › ')}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium text-gray-600 dark:text-gray-300">Rows</th>
            {values.map(v => (
              <th key={v} scope="col" className="px-3 py-2 text-right font-medium text-gray-600 dark:text-gray-300">
                {labelFor(columns, v)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          <GroupRows groups={groups} path={[]} values={values} expanded={expanded} onFlip={flip}
            filter={filter} onToggle={onToggle} />
        </tbody>
      </table>
    </div>
  );
}

function GroupRows({ groups, path, values, expanded, onFlip, filter, onToggle }) {
  const shown = groups.slice(0, MAX_GROUPS);
  return (
    <>
      {shown.map((group) => {
        const own = [...path, { key: group.key, label: group.label }];
        const id = JSON.stringify(own);
        const open = expanded.has(id);
        return [
          <PivotRow key={id} group={group} depth={path.length} values={values} open={open}
            onFlip={() => onFlip(id)} active={sameFilter(filter, own)} onFilter={() => onToggle(own)} />,
          open && (
            <GroupRows key={`${id}/children`} groups={group.children} path={own} values={values}
              expanded={expanded} onFlip={onFlip} filter={filter} onToggle={onToggle} />
          ),
        ];
      })}
      {groups.length > shown.length && (
        <tr>
          <td colSpan={values.length + 2} className="px-3 py-1.5 text-xs text-gray-600 dark:text-gray-400"
            style={{ paddingLeft: `${0.75 + path.length * 1.25}rem` }}>
            and {fmt(groups.length - shown.length)} more — narrow the table below, or open the XLSX download
          </td>
        </tr>
      )}
    </>
  );
}

function PivotRow({ group, depth, values, open, onFlip, active, onFilter }) {
  const canOpen = group.children.length > 0;
  return (
    <tr className={active ? 'bg-blue-50 dark:bg-blue-900/30' : undefined}>
      <td className="px-3 py-1.5" style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}>
        <span className="flex items-center gap-1">
          {canOpen ? (
            <button type="button" onClick={onFlip} aria-expanded={open}
              aria-label={`${open ? 'Collapse' : 'Expand'} ${group.label}`}
              className="w-4 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white">
              <span aria-hidden="true">{open ? '▾' : '▸'}</span>
            </button>
          ) : <span className="w-4" aria-hidden="true" />}
          <button type="button" aria-pressed={active} onClick={onFilter}
            className="text-left font-medium text-blue-700 hover:underline dark:text-blue-300">
            {group.label}
          </button>
        </span>
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums text-gray-700 dark:text-gray-300">{fmt(group.count)}</td>
      {values.map(v => (
        <td key={v} className="px-3 py-1.5 text-right tabular-nums text-gray-700 dark:text-gray-300">{fmt(group.totals[v])}</td>
      ))}
    </tr>
  );
}
