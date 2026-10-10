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

  it('bundles every group of one entity type into ONE clustered relation with the distinct count', () => {
    const relations = orgRelations(LINKED);
    expect(relations).toHaveLength(1);
    const [klant] = relations;
    expect(klant).toMatchObject({
      key: 'org:type:Klant', title: 'Klant', dir: 'out', count: 4, cluster: true,
      // the relation edge lists how this type is linked; a display-name match reads "name"
      label: 'eigenaar · name · worked on (Uren)',
      note: '12 Uren rows point at no Klant',
    });
    expect(klant.items.map(i => [i.key, i.label, i.edgeLabel])).toEqual([
      ['org-entity:k1', 'Contoso BV', 'eigenaar'],
      ['org-entity:k2', 'k2', 'eigenaar'],
      ['org-entity:k9', 'Northwind', 'name'],
      ['org-entity:k3', 'Fabrikam', 'worked on · 1,491 h (Uren)'],
    ]);
    expect(klant.items[3].detail).toBe('1491 h · 3 rows · until 2026-01');
  });

  it('one entity linked several ways is ONE item whose edge lists every way', () => {
    const team = { ...OWNER, key: 'direct|Klant|team', via: 'team', items: [OWNER.items[0]] };
    const alsoWorked = { ...WORKED, unlinkedRows: 0, items: [{ ...WORKED.items[0], entityId: 'k1', hours: 8 }] };
    const [klant] = orgRelations({ groups: [OWNER, team, alsoWorked] });
    expect(klant.count).toBe(2);
    expect(klant.items.find(i => i.entityId === 'k1').edgeLabel).toBe('eigenaar · team · worked on · 8 h (Uren)');
    expect(klant.note).toBeUndefined();
  });

  it('a single entity of a type stays inline (no cluster), and each type gets its own relation', () => {
    const person = { key: 'direct|Maten|displayName', entityType: 'Maten', via: 'displayName', kind: 'direct', count: 1, items: [{ entityId: 'm1', entityType: 'Maten', label: 'Ann' }] };
    const [klant, maten] = orgRelations({ groups: [NAME, person] });
    expect([klant.title, klant.cluster, klant.count]).toEqual(['Klant', false, 1]);
    expect([maten.title, maten.cluster, maten.label]).toEqual(['Maten', false, 'name']);
  });

  it('shortens the relation label past three kinds of link', () => {
    const groups = ['a', 'b', 'c', 'd'].map(via => ({ ...OWNER, key: via, via }));
    expect(orgRelations({ groups })[0].label).toBe('a · b · c …');
  });

  it('copes with a through item without hours, a group without items, count, source or entity type', () => {
    const odd = { groups: [
      { key: 't', kind: 'through', label: 'T', items: [{ entityId: 'z', hours: null }] },
      { key: 'g', kind: 'direct', via: 'team', label: 'G' },
    ] };
    const [rel] = orgRelations(odd);
    expect(rel.title).toBe('Organisation');
    expect(rel.label).toBe('worked on (other) · team');
    expect(rel.items).toEqual([{ key: 'org-entity:z', label: 'z', kind: 'item', entityKind: 'org-entity', entityId: 'z', edgeLabel: 'worked on (other)' }]);
    expect([rel.count, rel.cluster]).toEqual([1, false]);
  });

  it('keeps the server count when a list was capped', () => {
    const capped = orgRelations({ groups: [{ ...OWNER, count: 250, truncated: true }] })[0];
    expect(capped.count).toBe(250);
    expect(capped.note).toBe('showing the first 2 of 250');
  });
});
