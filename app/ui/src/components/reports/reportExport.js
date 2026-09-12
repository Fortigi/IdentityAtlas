// Downloading a report.
//
// The file itself is produced by the API (GET …/export), not rebuilt here: the
// server already knows the report's columns and rows, and a second, client-side
// serializer would be a second answer to the same question. This module is only
// the transport — request, name, save — and it is report-agnostic, like every
// other file in this folder.

import { filenameFromDisposition, triggerDownload } from '@ui/utils/download';

/** The export endpoint for one report in one format. */
export function reportExportUrl(name, format) {
  return `/api/reports/${encodeURIComponent(name)}/export?format=${encodeURIComponent(format)}`;
}

/**
 * Fetch one report as a file and save it. Resolves with the filename used;
 * throws (for the caller to surface) when the report could not be produced.
 * The server names the file via Content-Disposition — the local fallback only
 * covers a response that doesn't carry one.
 */
export async function downloadReport({ authFetch, name, format }) {
  const res = await authFetch(reportExportUrl(name, format));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const blob = await res.blob();
  const filename = filenameFromDisposition(res.headers?.get?.('Content-Disposition')) || `${name}.${format}`;
  triggerDownload(filename, blob);
  return filename;
}
