// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import ConfigWizard, { filesOverLimit, UPLOAD_LIMITS_URL } from './ConfigWizard.jsx';
import { DialogContext } from '@ui/components/dialogContext';
import { renderWithProviders, makeAuthFetch, screen, userEvent } from '@ui/test-utils/renderWithProviders';

// The wizard calls useDialog() for its in-app confirms, so supply a stub context
// (the real DialogProvider uses a portal that renderToStaticMarkup can't render).
const stubDialog = { confirm: async () => false, alert: () => {}, prompt: async () => null, toast: () => {} };

// renderToStaticMarkup executes the render synchronously, so a missing import
// (e.g. the back-reference to app/ui/src/components/Stepper, or the csv-slots.json
// import) throws here instead of only at runtime in the browser.
describe('CSV crawler ConfigWizard', () => {
  const render = (props = {}) =>
    renderToStaticMarkup(h(DialogContext.Provider, { value: stubDialog },
      h(ConfigWizard, {
        onComplete: () => {},
        onCancel: () => {},
        initialConfig: null,
        isEdit: false,
        authFetch: () => new Promise(() => {}),
        ...props,
      })));

  it('renders step 1 (system info) without throwing', () => {
    const html = render();
    expect(html).toContain('Add CSV Crawler');
    expect(html).toContain('Display name');
    expect(html).toContain('CSV delimiter');
  });

  it('shows "Edit CSV Crawler" in edit mode', () => {
    const html = render({ isEdit: true, initialConfig: { id: 1, systemName: 'Existing' } });
    expect(html).toContain('Edit CSV Crawler');
  });
});

// This block replaces the one that asserted a hard-coded `MAX_FILE_BYTES` of
// 1 GB — the assertion that kept a 1.8 GB export from ever being uploaded after
// the server's default rose to 8 GiB. The limit is the server's now.
describe('filesOverLimit — the server-reported per-file limit', () => {
  const staged = (...sizes) => sizes.map((size, i) => ({ file: { name: `f${i}.csv`, size } }));
  const GiB = 1024 ** 3;

  it('flags nothing while the limit is unknown — the server still enforces it', () => {
    expect(filesOverLimit(staged(100 * GiB), null)).toEqual([]);
    expect(filesOverLimit(staged(100 * GiB), undefined)).toEqual([]);
  });

  it('lets a 1.8 GB export through under the 8 GiB default', () => {
    expect(filesOverLimit(staged(1.8 * GiB), 8 * GiB)).toEqual([]);
  });

  it('flags only the files strictly over the limit', () => {
    const files = staged(2048, 2049, 10);
    expect(filesOverLimit(files, 2048).map(s => s.file.name)).toEqual(['f1.csv']);
  });
});

describe('ConfigWizard — mounted, with the limit coming from the server', () => {
  const GiB = 1024 ** 3;
  const mount = ({ limit, files, initialConfig = null } = {}) => {
    const handlers = {};
    if (limit !== undefined) handlers[UPLOAD_LIMITS_URL] = { maxFileBytes: limit };
    if (files) handlers['/files'] = files;
    const authFetch = makeAuthFetch(handlers);
    const utils = renderWithProviders(h(ConfigWizard, {
      onComplete: () => {}, onCancel: () => {}, initialConfig, isEdit: !!initialConfig, authFetch,
    }), { auth: { authFetch } });
    return { ...utils, authFetch };
  };
  const toUploadStep = async () => userEvent.click(await screen.findByRole('button', { name: /Next: Upload files/ }));

  it('renders the limit the server reports, not a constant', async () => {
    const { authFetch } = mount({ limit: 20 * GiB });
    await toUploadStep();
    expect(await screen.findByText('20.0 GB')).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledWith(UPLOAD_LIMITS_URL);
  });

  it('renders a limit above 1024 GB in TB', async () => {
    mount({ limit: 2 * 1024 * GiB });
    await toUploadStep();
    expect(await screen.findByText('2.0 TB')).toBeInTheDocument();
  });

  it('names no limit at all when the server does not report one', async () => {
    mount({});                                  // limits request -> 404
    await toUploadStep();
    expect(screen.getByText(/Files are auto-mapped by name/)).toBeInTheDocument();
    expect(screen.queryByText(/per file/)).toBeNull();
  });

  it('refuses a staged file over the reported limit, naming that limit', async () => {
    const { container } = mount({ limit: 1024 });
    await toUploadStep();
    await screen.findByText('1.0 KB');
    const input = container.querySelector('input[accept=".csv"]');
    await userEvent.upload(input, new File(['x'.repeat(2048)], 'Assignments.csv', { type: 'text/csv' }));
    expect(await screen.findByText(/exceeds the server.s 1\.0 KB per-file upload limit/)).toBeInTheDocument();
  });

  it('shows the folder a job reads from, so a large file can be copied there instead', async () => {
    mount({ limit: 8 * GiB, files: { files: [], folder: '/data/uploads/csv-7' }, initialConfig: { id: 7, systemName: 'IIQ' } });
    await toUploadStep();
    expect(await screen.findByText('/data/uploads/csv-7')).toBeInTheDocument();
  });
});
