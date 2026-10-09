import { describe, it, expect } from 'vitest';
import {
  targetKindLabel, viaLabel, groupTitle, rowsText, groupSubline, groupKey, candidateName, orderCandidates,
  candidateDetailKind, entityTypeOptions, canDecide, decisionBody, decisionToast, decisionError, totalPages,
  GROUPS_URL, DECISION_URL, REVIEW_STATUSES, DEFAULT_PAGE_SIZE,
} from './reviewGroups';

const GROUP = { entityType: 'Hours', via: 'customer', value: 'Contoso Harbour Ltd.', targetType: 'OrgEntity', entities: 42 };

describe('reviewGroups labels', () => {
  it('names each target type in the analyst\'s words, and passes an unknown one through', () => {
    expect(['Principal', 'Identity', 'Resource', 'Context', 'OrgEntity'].map(targetKindLabel))
      .toEqual(['Account', 'Person', 'Group', 'Context', 'another list']);
    expect(targetKindLabel('Device')).toBe('Device');
    expect(targetKindLabel(undefined)).toBe('');
  });

  it('reads the entity\'s own name as "name" and keeps any other attribute', () => {
    expect(viaLabel('displayName')).toBe('name');
    expect(viaLabel(null)).toBe('name');
    expect(viaLabel('owner')).toBe('owner');
  });

  it('builds the card title and subline', () => {
    expect(groupTitle(GROUP)).toBe('Hours · customer = “Contoso Harbour Ltd.”');
    expect(groupTitle({ ...GROUP, via: 'displayName', value: 'Portal' })).toBe('Hours · name = “Portal”');
    expect(groupSubline(GROUP)).toBe('42 rows · links to another list');
    expect(groupSubline({ ...GROUP, entities: 1, targetType: 'Principal' })).toBe('1 row · links to Account');
  });

  it('counts rows with the right plural, treating junk as zero', () => {
    expect(rowsText(1)).toBe('1 row');
    expect(rowsText(2)).toBe('2 rows');
    expect(rowsText(0)).toBe('0 rows');
    expect(rowsText(undefined)).toBe('0 rows');
    expect(rowsText('3')).toBe('3 rows');
  });

  it('keys a group on all four of its parts', () => {
    expect(groupKey(GROUP)).not.toBe(groupKey({ ...GROUP, targetType: 'Resource' }));
    expect(groupKey(GROUP)).not.toBe(groupKey({ ...GROUP, via: 'owner' }));
    expect(groupKey(GROUP)).not.toBe(groupKey({ ...GROUP, value: 'Other' }));
    expect(groupKey(GROUP)).not.toBe(groupKey({ ...GROUP, entityType: 'Projects' }));
    expect(groupKey({ ...GROUP })).toBe(groupKey(GROUP));
  });

  it('names a candidate by label, else id, else unknown', () => {
    expect(candidateName({ label: 'Contoso', targetId: 't1' })).toBe('Contoso');
    expect(candidateName({ label: null, targetId: 't1' })).toBe('t1');
    expect(candidateName({})).toBe('(unknown)');
  });
});

describe('orderCandidates', () => {
  it('puts the best first, ties by name, a missing confidence last, and leaves the input alone', () => {
    const input = [
      { targetId: 'a', label: 'Beta', confidence: 60 },
      { targetId: 'b', label: 'Gamma', confidence: null },
      { targetId: 'c', label: 'Alpha', confidence: 60 },
      { targetId: 'd', label: 'Delta', confidence: 90 },
    ];
    expect(orderCandidates(input).map(c => c.label)).toEqual(['Delta', 'Alpha', 'Beta', 'Gamma']);
    expect(input[0].label).toBe('Beta');
    expect(orderCandidates(undefined)).toEqual([]);
  });

  it('places a zero confidence above a missing one', () => {
    expect(orderCandidates([{ label: 'x', confidence: null }, { label: 'y', confidence: 0 }]).map(c => c.label)).toEqual(['y', 'x']);
  });
});

describe('candidateDetailKind', () => {
  it('opens another list\'s entity as an org entity and system targets as their detail page', () => {
    expect(candidateDetailKind('OrgEntity')).toBe('org-entity');
    expect(candidateDetailKind('Principal')).toBe('user');
    expect(candidateDetailKind('Resource')).toBe('resource');
    expect(candidateDetailKind('Nope')).toBeNull();
  });
});

describe('entityTypeOptions', () => {
  it('merges the model\'s types, the page\'s types and the current one, distinct and sorted', () => {
    expect(entityTypeOptions([{ type: 'Project' }, { type: 'Hours' }, {}], [{ entityType: 'Asset' }, { entityType: 'Hours' }, {}], 'Zone'))
      .toEqual(['Asset', 'Hours', 'Project', 'Zone']);
    expect(entityTypeOptions(undefined, undefined, '')).toEqual([]);
  });
});

describe('canDecide', () => {
  it('only lets an importer decide open proposals', () => {
    expect(canDecide('proposed', true)).toBe(true);
    expect(canDecide('accepted', true)).toBe(false);
    expect(canDecide('rejected', true)).toBe(false);
    expect(canDecide('proposed', false)).toBe(false);
  });
});

describe('decisionBody', () => {
  it('sends the group\'s four keys, the action and the chosen target', () => {
    expect(decisionBody({ ...GROUP, candidates: [], bestConfidence: 50 }, 'confirmed', 't1')).toEqual({
      entityType: 'Hours', via: 'customer', value: 'Contoso Harbour Ltd.', targetType: 'OrgEntity', action: 'confirmed', targetId: 't1',
    });
  });

  it('leaves targetId out for the whole group', () => {
    const body = decisionBody(GROUP, 'rejected');
    expect(body).toEqual({ entityType: 'Hours', via: 'customer', value: 'Contoso Harbour Ltd.', targetType: 'OrgEntity', action: 'rejected' });
    expect('targetId' in body).toBe(false);
  });
});

describe('decisionToast / decisionError', () => {
  it('says how many rows were linked, or rejected', () => {
    expect(decisionToast('confirmed', { accepted: 42, rejected: 3 }, 'Contoso')).toBe('42 rows linked to Contoso');
    expect(decisionToast('confirmed', { accepted: 1 }, 'Contoso')).toBe('1 row linked to Contoso');
    expect(decisionToast('rejected', { accepted: 0, rejected: 5 }, 'Contoso')).toBe('5 rows rejected for Contoso');
    expect(decisionToast('rejected', { accepted: 0, rejected: 7 }, '')).toBe('7 rows rejected');
    expect(decisionToast('rejected', undefined, '')).toBe('0 rows rejected');
  });

  it('turns a failure into a sentence', () => {
    expect(decisionError(501, 'x')).toBe('Reviewing links is not available yet.');
    expect(decisionError(404, 'No open proposal for that value.')).toBe('The decision was not saved: No open proposal for that value.');
    expect(decisionError(500, '')).toBe('The decision was not saved (HTTP 500).');
  });
});

describe('totalPages and constants', () => {
  it('rounds up, and falls back to the default page size', () => {
    expect(totalPages(101, 50)).toBe(3);
    expect(totalPages(100, 50)).toBe(2);
    expect(totalPages(0, 50)).toBe(0);
    expect(totalPages(51, undefined)).toBe(2);
    expect(totalPages(undefined, 50)).toBe(0);
    expect(DEFAULT_PAGE_SIZE).toBe(50);
  });

  it('points at the groups routes and offers the three statuses', () => {
    expect(GROUPS_URL).toBe('/api/org-truth/review/groups');
    expect(DECISION_URL).toBe('/api/org-truth/review/groups/decision');
    expect(REVIEW_STATUSES).toEqual(['proposed', 'accepted', 'rejected']);
  });
});
