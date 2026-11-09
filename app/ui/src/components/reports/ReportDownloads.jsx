// A report's download buttons: one main format, the rest in a small menu.
//
// The formats are whatever the API advertised — the UI never assumes which a
// deployment serves. The workbook is the main one when it is offered: it is the
// only format that carries the report's summary sheet, pivot tables and charts.
// CSV and JSON stay available for scripts and imports, one click further away.

import { usePopover } from '@ui/components/matrix/usePopover';
import { primaryFormat } from './reportExport';

const label = format => `Download ${format.toUpperCase()}`;

export default function ReportDownloads({ formats, downloading, onDownload }) {
  const { open, toggle, close, triggerRef, panelRef } = usePopover();
  if (!formats.length) return null;

  const primary = primaryFormat(formats);
  const others = formats.filter(f => f !== primary);
  const busy = downloading !== null;
  const otherBusy = busy && downloading !== primary;

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={() => onDownload(primary)}
        disabled={busy}
        className={`bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600 ${others.length ? 'rounded-l' : 'rounded'}`}
      >
        {downloading === primary ? 'Preparing…' : label(primary)}
      </button>
      {others.length > 0 && (
        <button
          ref={triggerRef}
          type="button"
          onClick={toggle}
          disabled={busy}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={otherBusy ? 'Preparing…' : 'Other download formats'}
          className="rounded-r border-l border-blue-500 bg-blue-600 px-2 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:border-blue-500 dark:bg-blue-700 dark:hover:bg-blue-600"
        >
          {otherBusy ? 'Preparing…' : <span aria-hidden="true">▾</span>}
        </button>
      )}
      {open && (
        <div ref={panelRef} role="menu" aria-label="Other download formats"
          className="absolute right-0 top-full z-50 mt-1 min-w-[10rem] rounded border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-800">
          {others.map((format, i) => (
            <button
              key={format}
              type="button"
              role="menuitem"
              data-autofocus={i === 0 ? true : undefined}
              onClick={() => { close(); onDownload(format); }}
              className="block w-full px-3 py-1.5 text-left text-sm text-gray-800 hover:bg-gray-100 focus:bg-gray-100 focus:outline-none dark:text-gray-200 dark:hover:bg-gray-700 dark:focus:bg-gray-700"
            >
              {label(format)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
