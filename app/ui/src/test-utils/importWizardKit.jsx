// Shared driving helpers for the Organisation import-wizard mount tests
// (ImportWizard.mount.test.jsx, ImportWizard.templates.mount.test.jsx).
import { vi } from 'vitest';
import ImportWizard from '@ui/components/orgtruth/wizard/ImportWizard';
import { renderWithProviders, makeAuthFetch, screen, userEvent } from './renderWithProviders';

// A tiny router: `routes['POST /sources']` → body | Response | (opts) => body.
export function api(routes) {
  return makeAuthFetch((url, opts) => {
    const key = `${opts.method ?? 'GET'} ${String(url).replace('/api/org-truth', '')}`;
    const r = routes[key];
    return typeof r === 'function' ? r(opts) : r;
  });
}

const callKey = ([url, opts]) => `${opts?.method ?? 'GET'} ${String(url).replace('/api/org-truth', '')}`;

// The parsed JSON body of the first call to `key` ('POST /runs/dry-run').
export const bodyOf = (authFetch, key) => {
  const call = authFetch.mock.calls.find(c => callKey(c) === key);
  return call && JSON.parse(call[1].body);
};

// Every parsed JSON body sent to `key`, in order.
export const bodiesOf = (authFetch, key) => authFetch.mock.calls.filter(c => callKey(c) === key).map(c => JSON.parse(c[1].body));

export const proposeCalls = (authFetch) => authFetch.mock.calls.filter(([url]) => String(url).endsWith('/propose/recipe')).length;

export const next = () => userEvent.click(screen.getByRole('button', { name: 'Next →' }));

export async function upload(name = 'projects.csv') {
  const file = new File(['ProjectCode;ProjectName\nP1;Apollo'], name, { type: 'text/csv', lastModified: Date.UTC(2026, 8, 30) });
  await userEvent.upload(screen.getByLabelText('Choose file'), file);
  return file;
}

export function renderWizard(authFetch, props = {}) {
  const onClose = vi.fn();
  renderWithProviders(<ImportWizard onClose={onClose} {...props} />, { auth: { authFetch } });
  return onClose;
}
