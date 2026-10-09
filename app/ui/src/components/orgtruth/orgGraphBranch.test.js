import { describe, it, expect, vi } from 'vitest';
import {
  orgLinkedUrl,
  asOrgLinked,
  loadOrgLinked,
  groupNote,
  viaLabel,
  orgRelations,
} from '@ui/components/orgtruth/orgGraphBranch';
import { makeAuthFetch, jsonResponse } from '@ui/test-utils/renderWithProviders';

const OWNER = {
  key: 'direct|Klant|eigenaar', entityType: 'Klant', via: 'eigenaar', kind: 'direct',
  label: 'Klant · eigenaar', count: 2, truncated: false,
  items: [
    { entityId: 'k1', entityType: 'Klant', label: 'Contoso BV', detail: null },
    { entityId: 'k2', entityType: 'Klant', label: '', detail: null },
  ],
};
const NAME = {
  key: 'direct|Klant|displayName', entityType: 'Klant', via: 'displayName', kind: 'direct',
  label: 'Klant · name', count: 1, items: [{ entityId: 'k9', entityType: 'Klant', label: 'Northwind' }],
};
const WORKED = {
  key: 'through|Klant|Uren|klant', entityType: 'Klant', via: 'klant', kind: 'through', sourceType: 'Uren',
  label: 'Klant · worked on (Uren)', count: 1, truncated: false, unlinkedRows: 12,
  items: [{ entityId: 'k3', entityType: 'Klant', label: 'Fabrikam', detail: '1491 h · 3 rows · until 2026-01', hours: 1491 }],
};
const LINKED = { total: 4, groups: [OWNER, NAME, WORKED] };
const URL = '/api/org-truth/linked/Principal/p1';

describe('orgLinkedUrl', () => {
  it('maps the four graph kinds to the endpoint target types and encodes the id', () => {
    expect(orgLinkedUrl('user', 'a b')).toBe('/api/org-truth/linked/Principal/a%20b');
    expect(orgLinkedUrl('identity', 'i1')).toBe('/api/org-truth/linked/Identity/i1');
    expect(orgLinkedUrl('resource', 'r1')).toBe('/api/org-truth/linked/Resource/r1');
    expect(orgLinkedUrl('context', 'c1')).toBe('/api/org-truth/linked/Context/c1');
  });

  it('has no url for other kinds or a missing id', () => {
    expect(orgLinkedUrl('access-package', 'x')).toBeNull();
    expect(orgLinkedUrl('org-entity', 'x')).toBeNull();
    expect(orgLinkedUrl('user', '')).toBeNull();
  });
});

describe('asOrgLinked', () => {
  it('keeps a payload with a groups array and drops anything else', () => {
    expect(asOrgLinked(LINKED)).toBe(LINKED);
    expect(asOrgLinked({ total: 0, groups: [] })).toEqual({ total: 0, groups: [] });
    expect(asOrgLinked({ error: 'off' })).toBeNull();
    expect(asOrgLinked(null)).toBeNull();
  });
});

describe('loadOrgLinked', () => {
  it('fetches once per url and authFetch, then answers from the cache', async () => {
    const authFetch = makeAuthFetch({ [URL]: LINKED });
    expect(await loadOrgLinked(URL, authFetch)).toEqual(LINKED);
    expect(await loadOrgLinked(URL, authFetch)).toEqual(LINKED);
    expect(authFetch).toHaveBeenCalledTimes(1);
    // A different authFetch (another sign-in) asks again.
    const other = makeAuthFetch({ [URL]: LINKED });
    await loadOrgLinked(URL, other);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['404 (feature off)', jsonResponse({ error: 'off' }, { ok: false, status: 404 })],
    ['501', jsonResponse({ error: 'not built' }, { ok: false, status: 501 })],
    ['a payload without groups', { total: 3 }],
  ])('answers null on %s and does not cache it', async (_name, response) => {
    const authFetch = makeAuthFetch({ [URL]: response });
    expect(await loadOrgLinked(URL, authFetch)).toBeNull();
    expect(await loadOrgLinked(URL, authFetch)).toBeNull();
    expect(authFetch).toHaveBeenCalledTimes(2);
  });

  it('answers null when the request throws', async () => {
    const authFetch = vi.fn(async () => { throw new Error('network'); });
    expect(await loadOrgLinked(URL, authFetch)).toBeNull();
  });
});

describe('groupNote', () => {
  it('names the unlinked fact rows of a through group', () => {
    expect(groupNote(WORKED)).toBe('12 Uren rows point at no Klant');
  });

  it('is null when nothing is unlinked or capped', () => {
    expect(groupNote(OWNER)).toBeNull();
    expect(groupNote({ ...WORKED, unlinkedRows: 0 })).toBeNull();
  });

  it('mentions a server-side cap, alone or after the unlinked rows', () => {
    expect(groupNote({ ...OWNER, count: 250, truncated: true })).toBe('showing the first 2 of 250');
    expect(groupNote({ ...WORKED, count: 300, truncated: true }))
      .toBe('12 Uren rows point at no Klant · showing the first 1 of 300');
  });

  it('falls back when the source type is missing', () => {
    expect(groupNote({ ...WORKED, sourceType: undefined })).toBe('12 other rows point at no Klant');
  });
});

describe('viaLabel', () => {
  it('calls a display-name match "name" and keeps an attribute as it is', () => {
    expect(viaLabel('displayName')).toBe('name');
    expect(viaLabel(undefined)).toBe('name');
    expect(viaLabel('eigenaar')).toBe('eigenaar');
  });
});

describe('orgRelations', () => {
  it('is empty without a payload', () => {
    expect(orgRelations(null)).toEqual([]);
    expect(orgRelations({ groups: [] })).toEqual([]);
  });

  it('turns a direct group into one relation labelled with the linking attribute, objects as direct neighbours', () => {
    const [owner, name] = orgRelations(LINKED);
    expect(owner).toEqual({
      key: 'org:direct|Klant|eigenaar', title: 'Klant · eigenaar', label: 'eigenaar', dir: 'out', count: 2,
      items: [
        { key: 'org-entity:k1', label: 'Contoso BV', kind: 'item', entityKind: 'org-entity', entityId: 'k1', resourceType: 'Klant' },
        { key: 'org-entity:k2', label: 'k2', kind: 'item', entityKind: 'org-entity', entityId: 'k2', resourceType: 'Klant' },
      ],
    });
    // A match on the display name reads "name", not "displayName".
    expect(name.label).toBe('name');
    expect(name.items.map(i => i.edgeLabel)).toEqual([undefined]);
  });

  it('labels each through edge with the hours it adds up to, and keeps the note for the list', () => {
    const worked = orgRelations(LINKED)[2];
    expect(worked.label).toBe('worked on (Uren)');
    expect(worked.items[0].edgeLabel).toBe('worked on · 1,491 h (Uren)');
    expect(worked.items[0].detail).toBe('1491 h · 3 rows · until 2026-01');
    expect(worked.note).toBe('12 Uren rows point at no Klant');
  });

  it('copes with a through item without hours, a group without items, count or source type', () => {
    const odd = { groups: [
      { key: 't', kind: 'through', label: 'T', items: [{ entityId: 'z', hours: null }] },
      { key: 'g', kind: 'direct', via: 'team', label: 'G' },
    ] };
    const [t, g] = orgRelations(odd);
    expect(t.items[0]).toEqual({ key: 'org-entity:z', label: 'z', kind: 'item', entityKind: 'org-entity', entityId: 'z', edgeLabel: 'worked on (other)' });
    expect(t.count).toBe(1);
    expect(g).toEqual({ key: 'org:g', title: 'G', label: 'team', dir: 'out', count: 0, items: [] });
  });

  it('keeps the server count when the list was capped', () => {
    const capped = orgRelations({ groups: [{ ...OWNER, count: 250, truncated: true }] })[0];
    expect(capped.count).toBe(250);
    expect(capped.note).toBe('showing the first 2 of 250');
  });
});
