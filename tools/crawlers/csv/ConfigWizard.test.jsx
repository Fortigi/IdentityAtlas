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

describe('ConfigWizard — source format and per-file mapping', () => {
  const GiB = 1024 ** 3;
  // Key order matters: makeAuthFetch picks the first key the URL CONTAINS, and
  // the header URL contains '/files' too.
  const mount = ({ initialConfig = null, files, header } = {}) => {
    const handlers = { [UPLOAD_LIMITS_URL]: { maxFileBytes: 8 * GiB } };
    if (header) handlers['/header'] = header;
    if (files) handlers['/files'] = files;
    const authFetch = makeAuthFetch(handlers);
    const utils = renderWithProviders(h(ConfigWizard, {
      onComplete: () => {}, onCancel: () => {}, initialConfig, isEdit: !!initialConfig, authFetch,
    }), { auth: { authFetch } });
    return { ...utils, authFetch };
  };
  const toUploadStep = async () => userEvent.click(await screen.findByRole('button', { name: /Next: Upload files/ }));
  const upload = async (container, file) => {
    await userEvent.upload(container.querySelector('input[accept=".csv"]'), file);
  };
  const csv = (name, header) => new File([`${header}\n`], name, { type: 'text/csv' });

  it('offers both source formats, defaulting to the Identity Atlas schema', () => {
    mount();
    expect(screen.getByRole('radio', { name: /Identity Atlas schema/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Custom mapping/ })).not.toBeChecked();
  });

  it('stores a real tab (U+0009) for the Tab delimiter option', async () => {
    // The bug this pins: <option value="\t"> in JSX stored a backslash and a t,
    // which no CSV reader could bind — every Tab-delimited import failed.
    mount();
    const select = screen.getByRole('combobox', { name: /CSV delimiter/ });
    const tab = [...select.options].find(o => o.textContent === 'Tab');
    expect(tab.value).toBe('\t');
    expect(tab.value).toHaveLength(1);
  });

  it('detects and shows each staged file\'s own delimiter', async () => {
    const { container } = mount();
    await toUploadStep();
    await upload(container, csv('Users.csv', 'ExternalId,DisplayName'));
    // Config-level default is ';', but this file is comma-delimited — and the
    // wizard says so rather than reading it wrong in silence.
    expect(await screen.findByText(/Delimiter \(Comma \(,\) detected\)/)).toBeInTheDocument();
    const select = await screen.findByRole('combobox', { name: 'CSV delimiter for Users.csv' });
    expect(select).toHaveValue(',');
  });

  it('keeps the config-level delimiter for a single-column file (a tie)', async () => {
    const { container } = mount();
    await toUploadStep();
    await upload(container, csv('Users.csv', 'ExternalId'));
    const select = await screen.findByRole('combobox', { name: 'CSV delimiter for Users.csv' });
    expect(select).toHaveValue(';');
  });

  it('maps a non-schema file per schema field, pre-filled by exact name match', async () => {
    const { container } = mount();
    await userEvent.click(screen.getByRole('radio', { name: /Custom mapping/ }));
    await toUploadStep();
    await upload(container, csv('ad_people.csv', 'samaccountname,DisplayName,office'));
    // The filename matches no slot, so the admin picks one — and only then does
    // the panel offer a row per schema field, with the file's REAL columns.
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Object type for ad_people.csv' }), 'users');
    const dnSelect = await screen.findByRole('combobox', { name: 'Source column for DisplayName in ad_people.csv' });
    expect(dnSelect).toHaveValue('DisplayName');        // exact-name pre-fill
    const extSelect = screen.getByRole('combobox', { name: 'Source column for ExternalId in ad_people.csv' });
    expect(extSelect).toHaveValue('');                  // no fuzzy guess
    expect([...extSelect.options].map(o => o.value)).toEqual(['', 'samaccountname', 'DisplayName', 'office']);

    // Required-but-unmapped is flagged per SCHEMA field, which is the thing the
    // admin has to go and fix.
    expect(await screen.findByText(/Unmapped required field: ExternalId/)).toBeInTheDocument();
    await userEvent.selectOptions(extSelect, 'samaccountname');
    expect(screen.queryByText(/Unmapped required field/)).toBeNull();
    expect(screen.getByText(/Columns you leave unmapped are kept as extended attributes/)).toBeInTheDocument();
  });

  it('offers a multi-value split on the Assignments slot only', async () => {
    const { container } = mount();
    await userEvent.click(screen.getByRole('radio', { name: /Custom mapping/ }));
    await toUploadStep();
    await upload(container, csv('Assignments.csv', 'group;members'));
    expect(await screen.findByRole('textbox', { name: /split delimiter for UserExternalId in Assignments.csv/i })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /split delimiter for AssignmentType/i })).toBeNull();
    expect(screen.getByText(/ignored for this file — they are named in the job log/)).toBeInTheDocument();
  });

  it('will not leave step 2 while a file cannot load, in either source format', async () => {
    const { container } = mount();
    await toUploadStep();
    // Schema-shaped mode: a Users file dropped into the Assignments slot.
    await upload(container, csv('Assignments.csv', 'ExternalId;DisplayName'));
    const next = await screen.findByRole('button', { name: /Next: Review/ });
    expect(await screen.findByText(/Missing columns: ResourceExternalId, UserExternalId/)).toBeInTheDocument();
    expect(next).toBeDisabled();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Object type for Assignments.csv' }), 'users');
    // Still disabled — Resources is now the slot nothing fills.
    expect(next).toBeDisabled();
    expect(screen.queryByText(/Missing columns:/)).toBeNull();
  });

  it('saves the source format and the per-file mapping into the config', async () => {
    const { container, authFetch } = mount();
    await userEvent.click(screen.getByRole('radio', { name: /Custom mapping/ }));
    await toUploadStep();
    await upload(container, csv('ad_people.csv', 'samaccountname,cn'));
    await upload(container, csv('ad_groups.csv', 'group_dn;group_name'));
    await upload(container, csv('ad_memberships.csv', 'group_dn;member'));

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Object type for ad_people.csv' }), 'users');
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Source column for ExternalId in ad_people.csv' }), 'samaccountname');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Source column for DisplayName in ad_people.csv' }), 'cn');
    // ad_groups.csv matched the "resources" slot loosely; map it too.
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Object type for ad_groups.csv' }), 'resources');
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Source column for ExternalId in ad_groups.csv' }), 'group_dn');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Source column for DisplayName in ad_groups.csv' }), 'group_name');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Object type for ad_memberships.csv' }), 'assignments');
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Source column for ResourceExternalId in ad_memberships.csv' }), 'group_dn');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Source column for UserExternalId in ad_memberships.csv' }), 'member');
    await userEvent.type(screen.getByRole('textbox', { name: /split delimiter for UserExternalId in ad_memberships.csv/i }), ',');

    await userEvent.click(screen.getByRole('button', { name: /Next: Review/ }));
    // The review step states each file's delimiter and how many columns it maps.
    expect(await screen.findByText(/Comma \(,\) · 2 mapped columns/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Create crawler/ }));

    const post = authFetch.mock.calls.find(([url, opts]) => url === '/api/admin/crawler-configs' && opts?.method === 'POST');
    const sent = JSON.parse(post[1].body).config;
    expect(sent.sourceFormat).toBe('custom');
    // The slot is what makes a non-canonical filename readable at all.
    expect(sent.files['ad_people.csv']).toEqual({
      slot: 'users', delimiter: ',', columns: { ExternalId: 'samaccountname', DisplayName: 'cn' },
    });
    expect(sent.files['ad_memberships.csv'].split).toEqual({ field: 'UserExternalId', delimiter: ',' });
  });

  it('saves no per-file section for a schema-shaped upload — the bypass path', async () => {
    const { container, authFetch } = mount();
    await toUploadStep();
    for (const name of ['Resources.csv', 'Users.csv']) await upload(container, csv(name, 'ExternalId;DisplayName'));
    await upload(container, csv('Assignments.csv', 'ResourceExternalId;UserExternalId'));
    await userEvent.click(await screen.findByRole('button', { name: /Next: Review/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Create crawler/ }));

    const post = authFetch.mock.calls.find(([url, opts]) => url === '/api/admin/crawler-configs' && opts?.method === 'POST');
    const sent = JSON.parse(post[1].body).config;
    expect(sent.files).toEqual({});
    expect(sent.sourceFormat).toBe('identityatlas');
    expect(sent.delimiter).toBe(';');
  });

  it('reads an already-uploaded file\'s header so it can be re-mapped on edit', async () => {
    const { authFetch } = mount({
      initialConfig: { id: 4, systemName: 'AD', sourceFormat: 'custom', delimiter: ';',
        files: { 'ad_people.csv': { slot: 'users', delimiter: ',', columns: { ExternalId: 'samaccountname' } } } },
      files: { files: [{ name: 'ad_people.csv', sizeBytes: 10, modifiedAt: '2026-11-01T00:00:00.000Z' }], folder: '/data/uploads/csv-4' },
      header: { name: 'ad_people.csv', header: 'samaccountname,cn,office' },
    });
    await toUploadStep();
    // The header comes from the new endpoint — a server-side file is not a
    // browser File object the wizard can slice.
    await screen.findByText(/Already uploaded/);
    expect(authFetch).toHaveBeenCalledWith('/api/admin/crawler-configs/4/files/ad_people.csv/header');
    const stored = await screen.findByRole('combobox', { name: 'Source column for ExternalId in ad_people.csv' });
    expect(stored).toHaveValue('samaccountname');
  });
});
