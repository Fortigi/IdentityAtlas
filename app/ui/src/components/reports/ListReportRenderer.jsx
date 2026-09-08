// Renderer for the `list` report form: a generic table built from whatever
// columns the report declared. It knows nothing about any particular report —
// the columns, the labels and the row keys all come from the API response.

import EmptyState from '@ui/components/EmptyState';

export default function ListReportRenderer({ report, onOpenDetail }) {
  const columns = report.columns || [];
  const rows = report.rows || [];

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No rows"
        hint={`${report.displayName} found nothing to report on the current data. Refresh after the next crawler or account-linking run to check again.`}
      />
    );
  }

  return (
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
          {rows.map((row, i) => (
            <ReportRow key={row._entity?.id || i} row={row} columns={columns} onOpenDetail={onOpenDetail} />
          ))}
        </tbody>
      </table>
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
