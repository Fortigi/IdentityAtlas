// @vitest-environment jsdom
//
// Downloading a report: the file has to come from the server's export endpoint
// (not from a second client-side serializer), be named the way the server asked,
// and fail loudly enough for the page to say so.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { blobResponse, makeAuthFetch } from '@ui/test-utils/renderWithProviders';
import { downloadReport, reportExportUrl } from './reportExport';

// The bytes are the server's; this module only moves them. The formats named
// below are likewise just strings passed through to the URL — the transport
// knows none of them by name.
const BYTES = '"Account"\r\n"Ada Lovelace"';

describe('reportExportUrl', () => {
  it('addresses the report by name and asks for the chosen format', () => {
    expect(reportExportUrl('sample-report', 'json')).toBe('/api/reports/sample-report/export?format=json');
    expect(reportExportUrl('sample-report', 'xml')).toBe('/api/reports/sample-report/export?format=xml');
  });

  it('encodes a name that would otherwise change the path', () => {
    expect(reportExportUrl('odd/name?x', 'json')).toBe('/api/reports/odd%2Fname%3Fx/export?format=json');
  });
});

describe('downloadReport', () => {
  let saved;

  beforeEach(() => {
    saved = [];
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake-url');
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function capture() {
      saved.push(this.download);
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('fetches the export endpoint and saves the file under the server-supplied name', async () => {
    const authFetch = makeAuthFetch(() => blobResponse(BYTES, {
      type: 'application/xml', filename: 'identity-atlas-sample-report-2026-09-12.xml',
    }));

    const filename = await downloadReport({ authFetch, name: 'sample-report', format: 'xml' });

    expect(authFetch).toHaveBeenCalledWith('/api/reports/sample-report/export?format=xml');
    expect(filename).toBe('identity-atlas-sample-report-2026-09-12.xml');
    expect(saved).toEqual(['identity-atlas-sample-report-2026-09-12.xml']);
  });

  it('saves the bytes the server sent, rather than rebuilding the file locally', async () => {
    const authFetch = makeAuthFetch(() => blobResponse(BYTES, { type: 'application/xml', filename: 'x.xml' }));

    await downloadReport({ authFetch, name: 'sample-report', format: 'xml' });

    expect(await globalThis.URL.createObjectURL.mock.calls[0][0].text()).toBe(BYTES);
  });

  it('falls back to a local name when the response carries no Content-Disposition', async () => {
    const authFetch = makeAuthFetch(() => blobResponse(BYTES, { type: 'application/xml' }));

    expect(await downloadReport({ authFetch, name: 'sample-report', format: 'xml' }))
      .toBe('sample-report.xml');
  });

  it.each([
    ['carries no headers at all', {}],
    ['carries headers that cannot be read', { headers: {} }],
  ])('falls back to a local name when the response %s', async (_label, over) => {
    // Defensive: a response shape without readable headers must still produce a
    // file, not a TypeError halfway through the download.
    const authFetch = makeAuthFetch(async () => ({
      ok: true, status: 200, json: async () => ({}), blob: async () => new Blob([BYTES]), ...over,
    }));

    expect(await downloadReport({ authFetch, name: 'sample-report', format: 'json' }))
      .toBe('sample-report.json');
    expect(saved).toEqual(['sample-report.json']);
  });

  it('throws with the status — and saves nothing — when the report fails to run', async () => {
    const authFetch = makeAuthFetch(() => blobResponse('{"error":"Failed to run report"}', { ok: false, status: 500 }));

    await expect(downloadReport({ authFetch, name: 'sample-report', format: 'xml' }))
      .rejects.toThrow('HTTP 500');
    expect(saved).toEqual([]);
  });

  it('throws when the deployment does not serve the requested format', async () => {
    const authFetch = makeAuthFetch(() => blobResponse('{"error":"Unsupported export format"}', { ok: false, status: 400 }));

    await expect(downloadReport({ authFetch, name: 'sample-report', format: 'pdf' }))
      .rejects.toThrow('HTTP 400');
  });
});
