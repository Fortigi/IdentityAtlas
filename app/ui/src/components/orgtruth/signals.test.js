import { describe, it, expect } from 'vitest';
import {
  FINDING_KINDS, collectionTypes, statusAttributeOptions, findingsOf, findingRows, settingsDraft,
  settingsError, splitValues, settingsBody, asOfText, DEFAULT_MONTHS,
} from './signals';

const MODEL = {
  entityTypes: [
    { type: 'Project', template: 'collection', attributeKeys: ['status', 'archief'] },
    { type: 'Klant', attributeKeys: ['sector', 'archief'] },
    { type: 'Maten', template: 'enrichment' },
    { type: 'Incompatibility', template: 'relation' },
  ],
  activities: [{ type: 'Uren', subjectType: 'OrgEntity', subjectEntityType: 'Klant' }],
};

describe('collectionTypes', () => {
  it('keeps only collections (a missing template is one), the activity subjects first', () => {
    expect(collectionTypes(MODEL)).toEqual(['Klant', 'Project']);
    expect(collectionTypes({ entityTypes: MODEL.entityTypes })).toEqual(['Project', 'Klant']);
    expect(collectionTypes(null)).toEqual([]);
  });
});

describe('statusAttributeOptions', () => {
  it('lists the type\'s attribute keys sorted, keeping a stored choice the model no longer has', () => {
    expect(statusAttributeOptions(MODEL, 'Klant', '')).toEqual(['archief', 'sector']);
    expect(statusAttributeOptions(MODEL, 'Klant', 'closed')).toEqual(['archief', 'closed', 'sector']);
    expect(statusAttributeOptions(MODEL, 'Klant', 'sector')).toEqual(['archief', 'sector']);
    expect(statusAttributeOptions(MODEL, 'Nope', '')).toEqual([]);
  });
});

describe('findingsOf / findingRows', () => {
  it('reads one kind of finding, an absent or malformed one as none', () => {
    expect(findingsOf({ findings: { inactive: [{ entityId: 'k1' }] } }, 'inactive')).toEqual([{ entityId: 'k1' }]);
    expect(findingsOf({ findings: { inactive: 'x' } }, 'inactive')).toEqual([]);
    expect(findingsOf(null, 'inactive')).toEqual([]);
  });

  it('describes an inactive entity with its last activity, or as never active', () => {
    const rows = findingRows('inactive', [
      { entityId: 'k1', label: 'Contoso', lastActivityOn: '2025-12-01', monthsSince: 7 },
      { entityId: 'k2', label: 'Northwind', lastActivityOn: null },
    ]);
    expect(rows.map(r => [r.entity, r.person, r.detail])).toEqual([
      [{ kind: 'org-entity', id: 'k1', label: 'Contoso' }, null, 'last activity December 2025 · 7 months ago'],
      [{ kind: 'org-entity', id: 'k2', label: 'Northwind' }, null, 'no activity recorded'],
    ]);
  });

  it('quotes the status value of an entity marked inactive', () => {
    expect(findingRows('markedInactiveButActive', [{ entityId: 'k1', label: 'Contoso', statusValue: 'true', lastActivityOn: '2026-05-01' }])[0].detail)
      .toBe('marked “true” · last activity May 2026');
  });

  it('links the actor of activity without membership and the member without activity to their own pages', () => {
    const [actor] = findingRows('activeWithoutMembership', [
      { entityId: 'k1', label: 'Contoso', actor: { targetType: 'Identity', targetId: 'i1', label: 'Ann Example' }, total: 12.5, lastOn: '2026-04-01' },
    ]);
    expect(actor.person).toEqual({ kind: 'identity', id: 'i1', label: 'Ann Example' });
    expect(actor.detail).toBe('12.5 · last activity April 2026');
    const [member] = findingRows('memberWithoutActivity', [
      { entityId: 'k1', label: 'Contoso', member: { targetType: 'Principal', targetId: 'u1', label: 'Bob Example' }, role: 'eigenaar', lastOn: null },
    ]);
    expect(member.person).toEqual({ kind: 'user', id: 'u1', label: 'Bob Example' });
    expect(member.detail).toBe('eigenaar · no activity recorded');
    expect(member.key).toBe('k1|u1|0');
  });

  it('has a sentence for every kind it lists, and none for an unknown kind', () => {
    for (const k of FINDING_KINDS) expect(findingRows(k.key, [{ entityId: 'e', label: 'x', role: 'r' }])[0].detail).not.toBe('');
    expect(findingRows('other', [{ entityId: 'e', label: 'x' }])[0].detail).toBe('');
    expect(findingRows('inactive', null)).toEqual([]);
  });
});

describe('settings', () => {
  it('drafts the stored settings as text, with the defaults when there are none', () => {
    expect(settingsDraft({ inactiveAfterMonths: 9, statusAttribute: 'archief', inactiveValues: ['true', 'ja'] }))
      .toEqual({ months: '9', statusAttribute: 'archief', inactiveValues: 'true, ja' });
    expect(settingsDraft(undefined)).toEqual({ months: String(DEFAULT_MONTHS), statusAttribute: '', inactiveValues: '' });
    expect(DEFAULT_MONTHS).toBe(6);
  });

  it('accepts whole months from 1 to 120 only', () => {
    expect(settingsError({ months: '1' })).toBeNull();
    expect(settingsError({ months: ' 120 ' })).toBeNull();
    expect(settingsError({ months: '0' })).toMatch(/from 1 to 120/);
    expect(settingsError({ months: '121' })).toMatch(/from 1 to 120/);
    expect(settingsError({ months: '2.5' })).toMatch(/whole number/);
    expect(settingsError({ months: '' })).toMatch(/whole number/);
  });

  it('splits the inactive values on commas, trimmed, empty and repeated ones dropped', () => {
    expect(splitValues(' true, ja,, true ,')).toEqual(['true', 'ja']);
    expect(splitValues(undefined)).toEqual([]);
  });

  it('replaces only this type in the PUT body', () => {
    const all = { Project: { inactiveAfterMonths: 3, statusAttribute: null, inactiveValues: [] } };
    expect(settingsBody(all, 'Klant', { months: ' 9 ', statusAttribute: ' archief ', inactiveValues: 'true, ja' })).toEqual({
      Project: { inactiveAfterMonths: 3, statusAttribute: null, inactiveValues: [] },
      Klant: { inactiveAfterMonths: 9, statusAttribute: 'archief', inactiveValues: ['true', 'ja'] },
    });
  });

  it('drops the inactive values when no status attribute is chosen', () => {
    expect(settingsBody(null, 'Klant', { months: '6', statusAttribute: ' ', inactiveValues: 'true' }))
      .toEqual({ Klant: { inactiveAfterMonths: 6, statusAttribute: null, inactiveValues: [] } });
  });
});

describe('asOfText', () => {
  it('names the month the findings are measured against, or says there is no activity', () => {
    expect(asOfText({ asOf: '2026-06-30' })).toBe('Measured against the latest activity in the data: June 2026.');
    expect(asOfText({ asOf: null })).toBe('No activity has been imported for this type yet.');
  });
});
