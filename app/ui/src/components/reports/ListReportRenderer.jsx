// Renderer for the `list` report form: a generic table built from whatever
// columns the report declared. It knows nothing about any particular report —
// the columns, the labels and the row keys all come from the API response.
//
// Paged locally. A report is one request returning every row (that is what
// makes Refresh and the download agree), and one application's entitlement
// review is tens of thousands of them — drawing that as one table locks the
// browser up for the whole set. The rows are already in memory, so paging costs
// one slice and the download is unaffected: it re-runs the report, it does not
// read this table.

import { useCallback, useMemo, useState } from 'react';
import EmptyState from '@ui/components/EmptyState';
import Pagination from '@ui/components/Pagination';

export const ROWS_PER_PAGE = 100;

/** Which result set is on screen. A refresh re-runs the report, so `generatedAt` moves. */
const runKey = (report) => `${report?.name ?? ''}|${report?.generatedAt ?? ''}`;

export default function ListReportRenderer({ report, onOpenDetail }) {
  const columns = report.columns || [];
  const rows = useMemo(() => report.rows || [], [report.rows]);

  // The page is stored WITH the run it belongs to, and a page belonging to an
  // older run reads as 0. A refresh or a parameter change replaces the rows, and
  // staying on page 12 of a two-page result shows an empty table — but resetting
  // it from an effect is a cascading render (and a lint error); deriving it is
  // the same behaviour in one pass.
  const key = runKey(report);
  const [paging, setPaging] = useState({ key, page: 0 });
  const page = paging.key === key ? paging.page : 0;
  const setPage = useCallback(
    (next) => setPaging(prev => {
      const current = prev.key === key ? prev.page : 0;
      return { key, page: typeof next === 'function' ? next(current) : next };
    }),
    [key],
  );

  const totalPages = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  const safePage = Math.min(page, totalPages - 1);
  const visible = useMemo(
    () => rows.slice(safePage * ROWS_PER_PAGE, (safePage + 1) * ROWS_PER_PAGE),
    [rows, safePage],
  );

  if (rows.length === 0) {
    // A report that returned notices has already said why it is empty — it is
    // waiting for a parameter, a name matched nothing, an application has no
    // entitlements. Those notices are rendered above this table, so adding
    // "refresh after the next crawler run" here contradicts them and sends the
    // reader after a data problem that does not exist. Only one explanation
    // survives, and the report's own beats the engine's guess.
    const explained = (report.notices || []).length > 0;
    return (
      <EmptyState
        title="No rows"
        hint={explained ? undefined
          : `${report.displayName} found nothing to report on the current data. Refresh after the next crawler or account-linking run to check again.`}
      />
    );
  }

  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
        <table className="min-w-full text-sm">
          <caption className="sr-only">{report.displayName}</caption>
          <thead className="bg-gray-50 dark:bg-gray-700/50">
            <tr>
              {columns.map(col => (
                <th key={col.key} scope="col" className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300">
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {/* The fallback key is the row's position in the WHOLE result, not
                in the page: per-page indices repeat across pages, which would
                have React reuse row 0's node for the next page's row 0. */}
            {visible.map((row, i) => (
              <ReportRow
                key={row._entity?.id || safePage * ROWS_PER_PAGE + i}
                row={row}
                columns={columns}
                onOpenDetail={onOpenDetail}
              />
            ))}
          </tbody>
        </table>
      </div>
      <Pagination
        page={safePage}
        setPage={setPage}
        totalPages={totalPages}
        total={rows.length}
        pageSize={ROWS_PER_PAGE}
      />
    </div>
  );
}

// A row is clickable when the report attached an entity to it, so a finding can
// be acted on rather than just read.
function ReportRow({ row, columns, onOpenDetail }) {
  const entity = row._entity;
  const label = String(row[columns[0]?.key] ?? entity?.id ?? '');
  const open = entity && onOpenDetail ? () => onOpenDetail(entity.kind, entity.id, label) : null;

  return (
    <tr className={open ? 'cursor-pointer hover:bg-blue-50 dark:hover:bg-gray-700/50' : undefined}>
      {columns.map((col, i) => {
        const value = row[col.key];
        const text = value === null || value === undefined || value === '' ? '—' : String(value);
        return (
          <td key={col.key} className="px-4 py-2 text-gray-700 dark:text-gray-300">
            {open && i === 0 ? (
              <button
                type="button"
                onClick={open}
                className="text-left font-medium text-blue-700 hover:underline dark:text-blue-300"
              >
                {text}
              </button>
            ) : text}
          </td>
        );
      })}
    </tr>
  );
}
