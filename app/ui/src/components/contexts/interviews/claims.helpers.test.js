import { describe, it, expect } from 'vitest';
import {
  sourceLabel, subjectLabel, isUncertainMatch, periodLabel, groupConfirmed, proposedClaims, roleSuggestions,
  timelines, segmentBars, anyInProgress, manualClaimBody, manualClaimReady,
} from './claims.helpers';

const claim = (over) => ({ id: over.id ?? 'c', claimKind: 'role', status: 'proposed', intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01', ...over });

describe('labels', () => {
  it('names the source, and the matched person over the spoken name', () => {
    expect(sourceLabel(claim({}))).toBe('interview with Anna Voorbeeld, 2026-10-01');
    expect(subjectLabel(claim({ subjectName: 'Piet', subjectDisplayName: 'Piet Proefpersoon' }))).toBe('Piet Proefpersoon');
    expect(subjectLabel(claim({ subjectName: 'Piet' }))).toBe('Piet');
    expect(subjectLabel(claim({}))).toBe('');
  });

  it('flags a fuzzy or first-name match, nothing else', () => {
    expect(['fuzzy', 'firstName', 'name', 'key', 'interviewee', null].map(m => isUncertainMatch(claim({ subjectMatch: m }))))
      .toEqual([true, true, false, false, false, false]);
  });

  it('words a period from its dates and the text as said', () => {
    expect(periodLabel(claim({ periodFrom: '2015-01-01', periodTo: '2017-12-31' }))).toBe('2015–2017');
    expect(periodLabel(claim({ periodFrom: '2019-01-01', periodTo: '2019-12-31' }))).toBe('2019');
    expect(periodLabel(claim({ periodFrom: '2021-01-01', periodText: 'now' }))).toBe('since 2021 (now)');
    expect(periodLabel(claim({ periodTo: '2019-06-30' }))).toBe('until 2019');
    expect(periodLabel(claim({ periodText: 'early years' }))).toBe('early years');
    expect(periodLabel(claim({}))).toBe('');
  });
});

describe('grouping', () => {
  const claims = [
    claim({ id: 'd', claimKind: 'description', status: 'confirmed' }),
    claim({ id: 'p', claimKind: 'property', status: 'edited' }),
    claim({ id: 'r', claimKind: 'role', status: 'confirmed' }),
    claim({ id: 'h', claimKind: 'roleHistory', status: 'confirmed' }),
    claim({ id: 'x', claimKind: 'description', status: 'rejected' }),
    claim({ id: 'q', claimKind: 'role', status: 'proposed', roleSuggestion: 'Responsible' }),
    claim({ id: 'a', claimKind: 'role', status: 'proposed', roleSuggestion: 'Accountable' }),
    claim({ id: 'n', claimKind: 'roleHistory', status: 'proposed', roleSuggestion: 'Responsible' }),
  ];

  it('groups confirmed and edited claims; proposed and rejected stay out', () => {
    const g = groupConfirmed(claims);
    expect([g.description, g.properties, g.people].map(l => l.map(c => c.id))).toEqual([['d'], ['p'], ['r', 'h']]);
    expect(groupConfirmed(undefined).people).toEqual([]);
  });

  it('suggests a role from proposed role claims only', () => {
    expect(proposedClaims(claims).map(c => c.id)).toEqual(['q', 'a', 'n']);
    expect(roleSuggestions(claims, 'Responsible').map(c => c.id)).toEqual(['q']);
    expect(roleSuggestions(claims, 'Accountable').map(c => c.id)).toEqual(['a']);
  });
});

describe('timelines', () => {
  const P = 'p-1';
  const claims = [
    claim({ id: '3', claimKind: 'roleHistory', status: 'confirmed', principalId: P, subjectDisplayName: 'Bram Test', value: 'architect CCoE', periodFrom: '2022-01-01', periodText: 'now' }),
    claim({ id: '1', claimKind: 'roleHistory', status: 'confirmed', principalId: P, subjectDisplayName: 'Bram Test', value: 'junior', periodFrom: '2015-01-01', periodTo: '2017-12-31' }),
    claim({ id: '2', claimKind: 'roleHistory', status: 'confirmed', principalId: P, subjectDisplayName: 'Bram Test', value: 'left', periodText: 'for a while' }),
    claim({ id: '4', claimKind: 'role', status: 'confirmed', subjectName: 'Karel', value: 'day-to-day' }),
    claim({ id: '5', claimKind: 'roleHistory', status: 'proposed', principalId: P, value: 'not decided' }),
  ];

  it('one line per person, dated roles in time order and undated ones after, people by name', () => {
    expect(timelines(claims).map(p => [p.name, p.segments.map(s => s.label)])).toEqual([
      ['Bram Test', ['junior', 'architect CCoE', 'left']],
      ['Karel', ['day-to-day']],
    ]);
    expect(timelines(claims)[0].segments[1]).toEqual({ id: '3', label: 'architect CCoE', period: 'since 2022 (now)', from: '2022-01-01', to: undefined });
  });

  it('places dated bars on one axis, an open end at today, undated ones nowhere', () => {
    const today = Date.parse('2025-01-01T00:00:00Z');
    const bars = segmentBars([
      { from: '2015-01-01', to: '2020-01-01' },
      { from: '2020-01-01' },
      { label: 'vague' },
    ], today);
    expect(bars).toEqual([{ left: 0, width: 50 }, { left: 50, width: 50 }, null]);
    expect(segmentBars([{ label: 'vague' }], today)).toEqual([null]);
  });

  it('gives a one-day role a visible bar', () => {
    const bars = segmentBars([{ from: '2015-01-01', to: '2025-01-01' }, { from: '2020-01-01', to: '2020-01-01' }], Date.now());
    expect(bars[1].width).toBe(2);
  });
});

describe('anyInProgress', () => {
  it('is true while one interview waits or is being read', () => {
    expect(anyInProgress([{ extractionStatus: 'done' }, { extractionStatus: 'running' }])).toBe(true);
    expect(anyInProgress([{ extractionStatus: 'pending' }])).toBe(true);
    expect(anyInProgress([{ extractionStatus: 'failed' }, { extractionStatus: 'notConfigured' }])).toBe(false);
    expect(anyInProgress(undefined)).toBe(false);
  });
});

describe('the manual claim form', () => {
  const form = (over) => ({ kind: 'description', value: ' A tool ', subject: ' Piet ', relation: 'dayToDay', attribute: ' users ', periodText: '', quote: '', ...over });

  it('sends only what the kind uses, trimmed', () => {
    expect(manualClaimBody(form({}))).toEqual({ kind: 'description', value: 'A tool' });
    expect(manualClaimBody(form({ kind: 'role', periodText: ' now ', quote: ' Piet does it ' })))
      .toEqual({ kind: 'role', value: 'A tool', subject: 'Piet', relation: 'dayToDay', periodText: 'now', quote: 'Piet does it' });
    expect(manualClaimBody(form({ kind: 'roleHistory' }))).toEqual({ kind: 'roleHistory', value: 'A tool', subject: 'Piet' });
    expect(manualClaimBody(form({ kind: 'property' }))).toEqual({ kind: 'property', value: 'A tool', attribute: 'users' });
  });

  it('is ready with a value and the person or attribute its kind needs', () => {
    expect(manualClaimReady(form({ value: ' ' }))).toBe(false);
    expect(manualClaimReady(form({}))).toBe(true);
    expect(manualClaimReady(form({ kind: 'role', subject: ' ' }))).toBe(false);
    expect(manualClaimReady(form({ kind: 'roleHistory' }))).toBe(true);
    expect(manualClaimReady(form({ kind: 'property', attribute: '' }))).toBe(false);
    expect(manualClaimReady(form({ kind: 'property' }))).toBe(true);
  });
});
