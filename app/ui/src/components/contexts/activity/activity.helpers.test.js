import { describe, it, expect } from 'vitest';
import {
  activityRoleFields, withActivityRole, usedActivityColumns, activityProblems, activityStepFooter, ACTIVITY_STEPS,
  formatAmount, monthLabel, barHeights, groupInfo, personLink, periodFor, periodQuery, uploadLine, importLine, skippedLine, sectionShape,
  contextMatchHint, emptyContextOptions, distributionLine, sampleItems,
} from './activity.helpers';

const mapping = {
  sourceLabel: 'Clockify', contextColumn: 'Client', subjectNameColumn: 'User', subjectEmailColumn: 'Email',
  dateColumn: 'Start Date', dateOrder: 'mdy', amountColumn: 'Duration (decimal)', unit: 'hours', kindColumn: null,
  attributeColumns: ['Description', 'Task'],
};

describe('mapping edits', () => {
  it('offers the sub-unit column only on a context with sub-units', () => {
    expect(activityRoleFields(true).map(f => f.field)).toEqual(['contextColumn', 'subjectNameColumn', 'subjectEmailColumn', 'dateColumn', 'amountColumn', 'kindColumn']);
    expect(activityRoleFields(false).map(f => f.field)).not.toContain('contextColumn');
  });

  it('a column chosen for a role stops being an attribute; clearing a role keeps the attributes', () => {
    expect(withActivityRole(mapping, 'kindColumn', 'Task')).toMatchObject({ kindColumn: 'Task', attributeColumns: ['Description'] });
    expect(withActivityRole(mapping, 'kindColumn', '')).toMatchObject({ kindColumn: null, attributeColumns: ['Description', 'Task'] });
  });

  it('clearing the amount makes every row one event; choosing one again makes it hours', () => {
    const none = withActivityRole(mapping, 'amountColumn', '');
    expect(none).toMatchObject({ amountColumn: null, unit: 'events' });
    expect(withActivityRole(none, 'amountColumn', 'Duration (h)')).toMatchObject({ amountColumn: 'Duration (h)', unit: 'hours' });
    // Switching from one amount column to another keeps the unit the analyst chose.
    expect(withActivityRole({ ...mapping, unit: 'events' }, 'amountColumn', 'Duration (h)').unit).toBe('events');
  });

  it('usedActivityColumns is every role column', () => {
    expect([...usedActivityColumns(mapping)].sort()).toEqual(['Client', 'Duration (decimal)', 'Email', 'Start Date', 'User']);
  });
});

describe('activityProblems / activityStepFooter', () => {
  it('needs a source, a date and a person, and one role per column', () => {
    expect(activityProblems(mapping)).toEqual([]);
    expect(activityProblems({ ...mapping, sourceLabel: '  ' })).toEqual(['Name the source of this export.']);
    expect(activityProblems({ ...mapping, dateColumn: null })).toEqual(['Choose the column that holds the date.']);
    expect(activityProblems({ ...mapping, subjectNameColumn: null })).toEqual([]);
    expect(activityProblems({ ...mapping, subjectNameColumn: null, subjectEmailColumn: null })).toEqual(['Choose a column that names the person.']);
    expect(activityProblems({ ...mapping, kindColumn: 'Client' })).toEqual(['A column can play one role only.']);
  });

  it('gates each step: a file, a clean mapping, a preview with rows to import', () => {
    expect(activityStepFooter(ACTIVITY_STEPS.file, { file: null })).toEqual({ label: 'Read the file ▸', blocked: true, showBack: false });
    expect(activityStepFooter(ACTIVITY_STEPS.file, { file: {} }).blocked).toBe(false);
    expect(activityStepFooter(ACTIVITY_STEPS.mapping, { problems: ['x'] })).toEqual({ label: 'Preview ▸', blocked: true, showBack: true });
    expect(activityStepFooter(ACTIVITY_STEPS.mapping, { problems: [] }).blocked).toBe(false);
    expect(activityStepFooter(ACTIVITY_STEPS.preview, { preview: null }).blocked).toBe(true);
    expect(activityStepFooter(ACTIVITY_STEPS.preview, { preview: { rowsToImport: 0 } }).blocked).toBe(true);
    expect(activityStepFooter(ACTIVITY_STEPS.preview, { preview: { rowsToImport: 1 } })).toEqual({ label: 'Import', blocked: false, showBack: true });
  });
});

describe('formatting', () => {
  it('formatAmount rounds to one decimal and counts events', () => {
    expect(formatAmount(12.46, 'hours')).toBe('12.5 h');
    expect(formatAmount(1, 'events')).toBe('1 event');
    expect(formatAmount(3, 'events')).toBe('3 events');
    expect(formatAmount(null, 'hours')).toBe('—');
    expect(formatAmount(Number.NaN, 'hours')).toBe('—');
  });

  it('monthLabel names the month, with or without the year', () => {
    expect(monthLabel('2026-04')).toBe('Apr 2026');
    expect(monthLabel('2026-12', { short: true })).toBe('Dec');
    expect(monthLabel('2026-01', { short: true })).toBe('Jan');
  });

  it('barHeights scales to the largest month, and is flat without activity', () => {
    expect(barHeights([{ amount: 2 }, { amount: 8 }, { amount: 0 }])).toEqual([0.25, 1, 0]);
    expect(barHeights([{ amount: 0 }, { amount: 0 }])).toEqual([0, 0]);
  });

  it('uploadLine, importLine and skippedLine read as sentences', () => {
    expect(uploadLine({ sourceLabel: 'Clockify', fileName: 'q1.csv', periodStart: '2026-01-02', periodEnd: '2026-03-31', rowsHeld: 40 }))
      .toBe('Clockify · q1.csv · 2026-01-02 – 2026-03-31 · 40 rows');
    expect(uploadLine({ sourceLabel: 'Clockify', fileName: 'q1.csv', periodStart: null, rowsHeld: 0 })).toBe('Clockify · q1.csv · no dates · replaced by a later upload');
    expect(importLine({ rowsToImport: 120, subUnitsReached: 4, rowsNotPlaced: 3, rowsUnknownPerson: 2 })).toBe('120 rows to import on 4 units · 3 not placed · 2 by people not found');
    expect(importLine({ rowsToImport: 5, subUnitsReached: 1, rowsNotPlaced: 0, rowsUnknownPerson: 0 })).toBe('5 rows to import');
    expect(skippedLine({ 'no date': 2, 'no amount': 0, 'no person': 1 })).toBe('2 without a date · 1 without a person');
    expect(skippedLine(null)).toBe('');
  });
});

describe('groups, people and periods', () => {
  it('names every group, unknown keys by themselves', () => {
    expect(groupInfo('activeNotMember')).toMatchObject({ label: 'Active, not a member', suggestion: true });
    expect(groupInfo('memberAndActive').suggestion).toBeUndefined();
    expect(groupInfo('other')).toEqual({ label: 'other', help: '' });
  });

  it('a person opens their identity, else their account; a member by its kind; an unknown person nothing', () => {
    expect(personLink({ identityId: 'I1', principalId: 'P1' })).toEqual({ kind: 'identity', id: 'I1' });
    expect(personLink({ principalId: 'P1' })).toEqual({ kind: 'user', id: 'P1' });
    expect(personLink({ memberId: 'M1', memberType: 'Identity' })).toEqual({ kind: 'identity', id: 'M1' });
    expect(personLink({ memberId: 'M2', memberType: 'Principal' })).toEqual({ kind: 'user', id: 'M2' });
    expect(personLink({ subjectName: 'Ghost' })).toBeNull();
  });

  it('periodFor counts calendar months back from the latest date, across a year', () => {
    expect(periodFor('3', '2026-02-10')).toEqual({ from: '2025-12-01', to: '2026-02-10' });
    expect(periodFor('12', '2026-04-18')).toEqual({ from: '2025-05-01', to: '2026-04-18' });
    expect(periodFor('7', '2026-04-18')).toBeNull();
    expect(periodFor('3', null)).toBeNull();
    expect(periodQuery({ from: '2026-01-01', to: '2026-03-31' })).toBe('?from=2026-01-01&to=2026-03-31');
    expect(periodQuery(null)).toBe('');
    expect(periodQuery(null, true)).toBe('?includeSubUnits=true');
    expect(periodQuery({ from: '2026-01-01', to: '2026-03-31' }, false)).toBe('?from=2026-01-01&to=2026-03-31&includeSubUnits=false');
    expect(periodQuery(null, undefined)).toBe('');
  });

  it('contextMatchHint: the match count of the chosen column, singular for one value; null without a column or a count', () => {
    const analysis = { contextColumnMatches: { Client: { matched: 52, distinct: 58 }, Project: { matched: 0, distinct: 1 } } };
    expect(contextMatchHint(analysis, 'Client')).toBe('Client: 52 of 58 values match a unit');
    expect(contextMatchHint(analysis, 'Project')).toBe('Project: 0 of 1 value matches a unit');
    expect(contextMatchHint(analysis, 'User')).toBeNull();
    expect(contextMatchHint(analysis, null)).toBeNull();
    expect(contextMatchHint({}, 'Client')).toBeNull();
  });

  it('emptyContextOptions: this unit by name first (the default), then leave out', () => {
    expect(emptyContextOptions('Customers')).toEqual([{ value: 'self', label: 'Customers itself (default)' }, { value: 'skip', label: 'Leave them out' }]);
    expect(emptyContextOptions(undefined)[0].label).toBe('This unit itself (default)');
  });

  it('distributionLine: on itself always; the other parts only when there are rows', () => {
    const d = { onSelf: 0, onSubUnits: 0, subUnits: 0, deepestLevel: 0, unmatched: 0, ambiguous: 0, empty: 2, emptyTo: 'self' };
    expect(distributionLine(d, 'Customers')).toBe('On Customers itself: 0 rows');
    expect(distributionLine({ ...d, onSelf: 1, onSubUnits: 1, subUnits: 1, deepestLevel: 3, unmatched: 1, ambiguous: 2, emptyTo: 'skip' }, null))
      .toBe('On this unit itself: 1 row · on sub-units: 1 row across 1 unit (deepest level 3) · unmatched: 1 row · ambiguous: 2 rows · without a unit, left out: 2 rows');
    expect(distributionLine(null, 'Customers')).toBe('');
  });

  it('sampleItems: each sample with its rows', () => {
    expect(sampleItems([{ value: 'Support', rows: 1 }, { value: 'Ops', rows: 4 }])).toEqual(['Support (1 row)', 'Ops (4 rows)']);
    expect(sampleItems(undefined)).toEqual([]);
  });

  it('sectionShape: empty only without own activity, sub-unit activity and uploads', () => {
    const own = { period: { from: '2025-05-01', to: '2026-03-01' }, groups: [{ key: 'memberAndActive', people: [{}] }] };
    const summary = { period: { from: '2025-05-01', to: '2026-04-18' } };
    expect(sectionShape({ own, summary, uploads: [] })).toMatchObject({ empty: false, hasPeople: true, latest: '2026-04-18', shown: own.period });
    expect(sectionShape({ own: { period: null, groups: [] }, summary: null, uploads: [] }).empty).toBe(true);
    expect(sectionShape({ own: { period: null }, summary: null, uploads: [{ id: 'u' }] }).empty).toBe(false);
    expect(sectionShape({ own: { ...own, groups: [{ key: 'x', people: [] }] }, summary: null }).hasPeople).toBe(false);
    expect(sectionShape({ own, summary, chosenLatest: '2026-01-31' }).latest).toBe('2026-01-31');
    expect(sectionShape({ own: null, summary }).shown).toBe(summary.period);
  });
});
