// The Authorization workbench's test unit, shared by the page's mount tests (both
// orientations): three people, one business role containing two of the four
// access columns, knowledge in each state. Invented names.
import { vi } from 'vitest';
import { createElement as h } from 'react';
import WorkbenchPage from '@ui/components/workbench/WorkbenchPage';
import { renderWithProviders, userEvent, jsonResponse, makeAuthFetch } from './renderWithProviders';

export const UNIT = 'u-1';
export const claim = (id, status, extra = {}) => ({
  id, status, value: 'x', quote: 'they handle the claims', proposedBy: 'model', decidedBy: status === 'proposed' ? null : 'ann@x.test',
  contextName: 'Claims', source: { kind: 'interview', name: 'Marieke', fileName: 'i.txt', date: '2026-10-20' }, ...extra,
});
export const knows = (kind, name, state, claims) => ({ kind, objectId: null, name, state, claims });
const person = (key, displayName, knowledge, extra = {}) => ({
  key, identityId: key.slice(2), principalId: null, displayName, email: null, jobTitle: 'Handler', direct: true, units: ['Claims'],
  accounts: [{ id: `acc-${key}`, displayName, systemName: 'Dir' }], knowledge, ...extra,
});

export function payload() {
  return {
    unit: { id: UNIT, displayName: 'Claims Handling', contextType: 'Department', targetType: 'Identity', accountable: 'Marieke Jansen' },
    scope: { includeChildren: true, units: 3, truncatedPeople: false, maxPeople: 400 },
    kinds: [],
    people: [
      person('i:a', 'Anna Vos', [knows('activity', 'Handle claims', 'confirmed', [claim('c1', 'confirmed')])], {
        accounts: [{ id: 'acc-a', displayName: 'Anna Vos', systemName: 'Dir' }, { id: 'acc-a2', displayName: 'adm-anna', systemName: 'AD' }],
      }),
      person('i:b', 'Bram Smit', [
        knows('activity', 'Handle claims', 'proposed', [claim('c2', 'proposed')]),
        knows('duty', 'Works council member', 'confirmed', [claim('c3', 'confirmed')]),
      ]),
      person('i:c', 'Cleo Kok', []),
    ],
    columns: [
      { id: 'r1', displayName: 'ClaimsSuite Read', resourceType: 'AppRole', systemName: 'CS', isRole: false, holders: 3, contains: [], contexts: ['motor'] },
      { id: 'br', displayName: 'Claims handler', resourceType: 'BusinessRole', systemName: 'CS', isRole: true, holders: 1, contains: ['r1', 'r2'] },
      { id: 'r2', displayName: 'Motor handler', resourceType: 'AppRole', systemName: 'CS', isRole: false, holders: 2, contains: [], contexts: ['motor'] },
      { id: 'or', displayName: 'WorksCouncil site', resourceType: 'Group', systemName: 'Dir', isRole: false, holders: 1, contains: [], contexts: ['default'] },
    ],
    truncatedColumns: 0,
    // The contexts the columns are in, with their parents: Motor is a module of the ClaimsSuite application.
    contexts: [
      { id: 'suite', displayName: 'ClaimsSuite', contextType: 'LogicalApplication', parentId: null },
      { id: 'motor', displayName: 'Motor', contextType: 'LogicalApplication', parentId: 'suite' },
      { id: 'default', displayName: 'Default access', contextType: 'Tag', parentId: null },
    ],
    cells: [
      { person: 'i:a', resourceId: 'r1', type: 'Direct', accounts: ['acc-a'], viaRoles: ['br'] },
      { person: 'i:a', resourceId: 'br', type: 'Direct', accounts: ['acc-a'], viaRoles: [] },
      { person: 'i:a', resourceId: 'r2', type: 'Indirect', accounts: ['acc-a2'], viaRoles: [] },
      { person: 'i:b', resourceId: 'r1', type: 'Direct', accounts: ['acc-b'], viaRoles: [] },
      { person: 'i:b', resourceId: 'or', type: 'Direct', accounts: ['acc-b'], viaRoles: [] },
      { person: 'i:c', resourceId: 'r1', type: 'Eligible', accounts: ['acc-c'], viaRoles: [] },
      { person: 'i:c', resourceId: 'r2', type: 'Direct', accounts: ['acc-c'], viaRoles: [] },
    ],
    generatedAt: '2026-10-27T09:00:00.000Z',
  };
}

export function api({ fail = null } = {}) {
  const calls = [];
  const fetch = makeAuthFetch((url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : null });
    if (method !== 'GET') return fail ? jsonResponse({ error: fail }, { ok: false, status: 400 }) : { ok: true };
    if (url.startsWith(`/api/contexts/${UNIT}/workbench`)) return payload();
    return undefined;
  });
  return { fetch, calls };
}

export function mount(opts = {}) {
  const user = userEvent.setup();
  const a = api(opts);
  const onCacheData = vi.fn();
  renderWithProviders(h(WorkbenchPage, { contextId: UNIT, onCacheData, onClose: () => {} }), { auth: { authFetch: a.fetch } });
  return { user, calls: a.calls, onCacheData };
}
