// Shared fixtures for the Adjust tree mount tests: one small generated tree of
// people, its adjustments and attention items, and a stubbed API that serves
// them and records every write.

import { makeAuthFetch, jsonResponse } from '@ui/test-utils/renderWithProviders';

export const TREE_KEY = 'org:1';
export const KEY_IN_URL = encodeURIComponent(TREE_KEY);

const unit = (id, parentId, name, extra = {}) => ({
  id, parentId, name, contextType: 'ManagerHierarchy', contextCategory: 'OrganizationalUnit', variant: 'generated',
  memberCount: 0, totalMemberCount: 0, adjusted: false, createdByAdjustment: false, accountable: null, interim: null, ...extra,
});

export const TREE = {
  treeKey: TREE_KEY,
  kind: 'generated',
  name: 'Organisation',
  targetType: 'Principal',
  contextCategory: 'OrganizationalUnit',
  source: { systemId: 1, systemName: 'Entra ID', algorithmName: 'manager-hierarchy', lastRunAt: null },
  units: [
    unit('u-board', null, 'Board', { memberCount: 5, totalMemberCount: 20, accountable: { principalId: 'p-anna', name: 'Anna de Vries' } }),
    unit('u-fin', 'u-board', 'Finance', { memberCount: 5, totalMemberCount: 9, adjusted: true, accountable: { principalId: 'p-carl', name: 'Carl Jansen' } }),
    unit('u-acc', 'u-fin', 'Accounting', { memberCount: 4, totalMemberCount: 4 }),
    unit('u-it', 'u-board', 'IT', { memberCount: 6, totalMemberCount: 6, interim: { name: 'Bram Mertens', validUntil: '2027-03-31' } }),
    unit('u-staff', null, 'Staff', { createdByAdjustment: true }),
  ],
};

export const ADJUSTMENTS = [
  {
    id: 'a2', op: 'renameUnit', subjectId: 'u-fin', subjectName: 'Finance', payload: { name: 'Finance' }, reason: 'HR typo',
    validUntil: null, status: 'active', statusDetail: null, suggestion: null,
    description: 'Rename Fin to "Finance"', createdBy: 'Wim', createdAt: '2026-10-10T08:00:00Z',
  },
  {
    id: 'a1', op: 'moveUnit', subjectId: 'u-it', subjectName: 'IT', payload: { toParentId: 'u-ops' }, reason: null,
    validUntil: null, status: 'needsDecision', statusDetail: 'Operations is no longer in the source.',
    suggestion: { contextId: 'u-board', name: 'Board' },
    description: 'Move IT under Operations', createdBy: 'Gregor', createdAt: '2026-10-09T08:00:00Z',
  },
  {
    id: 'a0', op: 'renameUnit', subjectId: 'u-acc', subjectName: 'Accounting', payload: { name: 'Acc' }, reason: null,
    validUntil: null, status: 'reverted', statusDetail: null, suggestion: null,
    description: 'Rename Accounting to "Acc"', createdBy: 'Wim', createdAt: '2026-10-08T08:00:00Z',
  },
];

export const ATTENTION = [
  { id: 't1', kind: 'decision', severity: 'bad', title: 'Move IT under Operations needs a decision', detail: 'Operations is no longer in the source.', adjustmentId: 'a1', action: { type: 'follow', adjustmentId: 'a1', label: 'Follow the suggestion' } },
  { id: 't2', kind: 'splitCandidate', severity: 'warn', title: 'Split candidate: IT', detail: '3 of 6 people are in department "Data".', unitId: 'u-it', action: { type: 'split', subjectId: 'u-it', attribute: 'department', value: 'Data', label: 'Split off Data' } },
  { id: 't3', kind: 'notPlaced', severity: 'warn', title: '2 people are not placed', detail: null, unitId: 'u-staff', action: { type: 'select', unitId: 'u-staff', label: 'Show them' } },
  { id: 't4', kind: 'matches', severity: 'ok', title: 'Source now agrees: Rename Fin', detail: null, adjustmentId: 'a2', action: { type: 'remove', adjustmentId: 'a2', label: 'Remove adjustment' } },
];

export const MEMBERS = {
  'u-board': [
    { id: 'p-anna', displayName: 'Anna de Vries', jobTitle: 'CEO', department: 'Board' },
    { id: 'p-saar', displayName: 'Saar Dekker', jobTitle: 'Assistant', department: 'Board' },
  ],
  'u-fin': [{ id: 'p-tom', displayName: 'Tom Hendriks', department: 'Finance' }],
};

// The API of one tree. `overrides` replaces a GET's body by key: tree,
// adjustments, attention, splitOptions, users; `treeAfterWrite` is served for
// the tree once any write went through. `fail` makes every write answer 400.
export function adjustTreeApi({ tree = TREE, adjustments = ADJUSTMENTS, attention = ATTENTION, splitOptions = [], users = [], treeAfterWrite, fail } = {}) {
  let wrote = false;
  let seq = 10;
  const base = `/api/context-trees/${KEY_IN_URL}`;
  function write(method, opts) {
    if (fail) return jsonResponse({ error: fail }, { ok: false, status: 400 });
    wrote = true;
    const body = opts.body ? JSON.parse(opts.body) : {};
    seq += 1;
    // As the API answers: an addUnit's subject is the parent it went under.
    const subjectId = body.op === 'addUnit' ? body.parentId ?? null : body.subjectId;
    return jsonResponse({ adjustment: { id: `a${seq}`, subjectId, status: 'active', description: `Done ${body.op || method}` } }, { status: 201 });
  }
  return makeAuthFetch((url, opts = {}) => {
    const method = opts.method || 'GET';
    if (method !== 'GET') return write(method, opts);
    if (url === base) return wrote && treeAfterWrite ? treeAfterWrite : tree;
    if (url === `${base}/adjustments`) return { data: adjustments };
    if (url === `${base}/attention`) return { data: attention };
    if (url.startsWith(`${base}/units/`)) return { attributes: splitOptions };
    const m = url.match(/^\/api\/contexts\/([^/]+)\/members/);
    if (m) { const rows = MEMBERS[decodeURIComponent(m[1])] || []; return { data: rows, total: rows.length }; }
    if (url.startsWith('/api/users')) return { data: users };
    return undefined;
  });
}

// The writes the stubbed API received: [{ method, url, body }].
export function writesOf(authFetch) {
  return authFetch.mock.calls
    .filter(([, opts]) => opts?.method && opts.method !== 'GET')
    .map(([url, opts]) => ({ method: opts.method, url, body: opts.body ? JSON.parse(opts.body) : undefined }));
}
