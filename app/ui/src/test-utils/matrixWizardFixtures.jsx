// Shared fixtures for the Matrix wizard mount tests (#1202): a stubbed API that
// serves every endpoint the wizard touches, a render helper, and the few user
// gestures more than one test file needs. Kept here (not in a *.test.jsx) so the
// step tests and the save tests use ONE API stub rather than two that drift.

import { createElement as h } from 'react';
import { vi } from 'vitest';
import MatrixFilterWizard from '@ui/components/matrix/MatrixFilterWizard';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent } from './renderWithProviders';

// Column schema payloads returned by /api/matrix/columns ({ column, values }).
export const principalCols = [
  { column: 'displayName', values: [] },
  { column: 'department', values: ['Engineering', 'Sales'] },
  { column: 'jobTitle', values: ['Manager', 'Analyst'] },
  { column: 'city', values: ['London', 'Berlin'] },
];
export const resourceCols = [
  { column: 'displayName', values: [] },
  { column: 'resourceType', values: ['Group', 'Application'] },
];
export const identityCols = [
  { column: 'displayName', values: [] },
  { column: 'company', values: ['Acme', 'Globex'] },
];

export const previewBody = {
  subjectCount: 120, subjectTotal: 200,
  resourceCount: 30, resourceTotal: 50,
  assignmentCount: 1500,
};

export const HR_FILTER = {
  rowType: 'principal',
  subject: { include: [{ kind: 'attribute', field: 'department', values: ['HR'] }], exclude: [] },
};

export const ANN = { id: '3fa85f64-5717-4562-b3fc-2c963f66afa6', displayName: 'Ann Manager', userPrincipalName: 'ann@contoso.com' };
export const ANN_RECIPIENT = { principalId: ANN.id, userKey: 'ann@contoso.com', displayName: 'Ann Manager' };

// An authFetch serving the wizard's endpoints. Every response can be overridden:
//   saved    — GET /api/matrix/saved-filters rows
//   post     — POST /api/matrix/saved-filters response (default: the row the
//              API would store — the request body under id 'sf-new')
//   put      — PUT /api/matrix/saved-filters/:id response
//   share    — POST /api/matrix/shares response
//   shares   — GET /api/matrix/shares rows
//   preview  — merged into the preview counts
export function makeWizardFetch(overrides = {}) {
  const {
    saved = [{ id: 'sf-1', name: 'HR users', filter: HR_FILTER }],
    post,
    put = jsonResponse({ id: 'sf-1', name: 'HR users', filter: HR_FILTER }),
    share = jsonResponse({ id: 'sh-1', shareAddress: 'sh-1', recipients: [] }, { status: 201 }),
    shares = [],
    preview = {},
  } = overrides;
  // A share created during the test is SERVED BACK by the list, the way the API
  // does: the wizard hands a freshly-shared matrix to SharePanel, which reads the
  // live share to show its link. A stub whose list stayed empty would report that
  // the matrix is not shared and hide the very link this is here to prove.
  const created = [];
  // Saving and sharing — what the tests override.
  const savingRoute = (u, opts) => {
    if (u.startsWith('/api/matrix/shares/') && u.endsWith('/recipients') && opts.method === 'PUT') {
      const id = u.split('/')[4];
      const row = created.find(c => c.id === id);
      const { recipients } = JSON.parse(opts.body);
      if (row) row.recipients = recipients;
      return { id, recipients };
    }
    if (u.startsWith('/api/matrix/saved-filters/') && opts.method === 'PUT') return put;
    if (u === '/api/matrix/saved-filters' && opts.method === 'POST') {
      return post ?? jsonResponse({ id: 'sf-new', ...JSON.parse(opts.body) }, { status: 201 });
    }
    if (u === '/api/matrix/saved-filters') return saved;
    if (u === '/api/matrix/shares') {
      if (opts.method !== 'POST') return [...shares, ...created];
      const body = JSON.parse(opts.body);
      created.push({
        id: `sh-new-${created.length + 1}`,
        name: 'Shared matrix',
        savedFilterId: body.savedFilterId ?? 'sf-new',
        recipients: body.recipients,
        revokedAt: null,
      });
      return share;
    }
    return undefined;
  };
  return makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    return savingRoute(u, opts) ?? discoveryRoute(u, preview);
  });
}

// The wizard's read-only discovery endpoints: people, columns, preview, contexts.
function discoveryRoute(u, preview) {
  if (u.startsWith('/api/users')) return { data: [ANN] };
  if (u.includes('/api/matrix/columns')) {
    if (u.includes('entity=Identity')) return identityCols;
    return u.includes('entity=Resource') ? resourceCols : principalCols;
  }
  if (u.includes('/api/matrix/preview')) return { ...previewBody, ...preview };
  if (u.includes('/api/contexts?contextType=ManagerHierarchy')) {
    return { data: [{ id: 'ctx-1', displayName: 'Org Chart', totalMemberCount: 99 }] };
  }
  if (u.startsWith('/api/contexts/')) {
    const id = u.split('/').pop();
    return { attributes: { id, displayName: `Context ${id}`, variant: 'generated', targetType: 'Identity' } };
  }
  return undefined; // 404
}

// Matrix sharing on by default, so the default (wildcard) user may share.
export function renderWizard(props = {}, authFetch = makeWizardFetch(), options = {}) {
  const onApply = props.onApply || vi.fn();
  const onClose = props.onClose || vi.fn();
  const { features = { matrixSharing: true }, auth = {} } = options;
  const result = renderWithProviders(
    h(MatrixFilterWizard, {
      open: props.open ?? true,
      initialFilter: props.initialFilter,
      initialManaged: props.initialManaged,
      initialStep: props.initialStep,
      onApply,
      onClose,
    }),
    { auth: { ...auth, authFetch }, features },
  );
  return { ...result, onApply, onClose, authFetch, user: userEvent.setup() };
}

// Jump to a step through the step indicator.
export async function gotoStep(user, label) {
  await user.click(screen.getByRole('button', { name: new RegExp(`^Go to step \\d+: ${label}$`) }));
}

// Type into the people search and pick a result. The picker debounces, so the
// option only appears once the search has settled.
export async function pickPerson(user, name) {
  await user.type(screen.getByRole('textbox', { name: /^Share with/i }), name.split(' ')[0]);
  await user.click(await screen.findByRole('button', { name: new RegExp(name, 'i') }, { timeout: 3000 }));
}

// The JSON bodies sent to `url` with `method`, in call order.
export function bodiesSent(authFetch, url, method) {
  return authFetch.mock.calls
    .filter(([u, o]) => u === url && o?.method === method)
    .map(([, o]) => JSON.parse(o.body));
}
