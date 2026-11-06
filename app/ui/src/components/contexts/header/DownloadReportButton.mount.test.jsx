// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement as h } from 'react';
import DownloadReportButton from './DownloadReportButton';
import { renderWithProviders, makeAuthFetch, blobResponse, screen, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

// The header's main button runs the report headerActions.reportFor() names
// through the report export endpoint — the same call the report tab's Download
// button makes — as a spreadsheet, on this context alone.

function mount({ report = 'application-access-review', id = 'c-app', download } = {}) {
  const authFetch = makeAuthFetch(() => (download ? download() : blobResponse('xlsx-bytes', { type: 'application/octet-stream', filename: 'report.xlsx' })));
  renderWithProviders(h(DownloadReportButton, { attrs: { id }, report, title: 'What the spreadsheet holds' }), { auth: { authFetch } });
  return { authFetch, user: userEvent.setup() };
}

describe('DownloadReportButton', () => {
  beforeEach(() => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake-url');
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('says what it downloads on hover', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Download report' })).toHaveAttribute('title', 'What the spreadsheet holds');
  });

  it('runs the named report as a spreadsheet on this context, once', async () => {
    const { authFetch, user } = mount({ report: 'unit-members', id: 'c-unit' });
    await user.click(screen.getByRole('button', { name: 'Download report' }));
    expect(authFetch).toHaveBeenCalledWith('/api/reports/unit-members/export?format=xlsx&contexts=c-unit');
    expect(authFetch).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(globalThis.URL.createObjectURL).toHaveBeenCalled());
  });

  it('shows "Preparing…" while the file is produced, and the failure when it cannot be', async () => {
    let fail;
    const { user } = mount({ download: () => new Promise(res => { fail = () => res(blobResponse('{}', { ok: false, status: 500 })); }) });
    await user.click(screen.getByRole('button', { name: 'Download report' }));
    expect(screen.getByRole('button', { name: 'Preparing…' })).toBeDisabled();
    fail();
    expect(await screen.findByText('Download failed')).toBeInTheDocument();
    expect(screen.getByText('HTTP 500')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download report' })).toBeEnabled();
  });
});
