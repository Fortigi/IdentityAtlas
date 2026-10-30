import { describe, it, expect } from 'vitest';
import {
  sourceLabel, subjectLabel, isUncertainMatch, periodLabel, groupConfirmed, proposedClaims, roleSuggestions,
  timelines, segmentBars, anyInProgress, manualClaimBody, manualClaimReady, extractionLabel, BUSY_AFTER_MS,
  byRelevance, whatWeKnowSummary, claimLine, isLowRelevance, isLowConfidence, LOW_CONFIDENCE,
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

  it('flags a claim below the low-confidence mark, not one at it or without a confidence', () => {
    expect([0.3, LOW_CONFIDENCE, 0.9, null, undefined].map(c => isLowConfidence(claim({ confidence: c })))).toEqual([true, false, false, false, false]);
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

describe('extractionLabel', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const iv = (status, startedAt) => ({ extractionStatus: status, extractionStartedAt: startedAt });

  it('says waiting before the run starts and reading while it is young', () => {
    expect(extractionLabel(iv('pending', null), now)).toBe('Waiting for the model…');
    expect(extractionLabel(iv('running', '2026-10-23T11:58:01Z'), now)).toBe('Reading…');
    expect(extractionLabel(iv('running', null), now)).toBe('Reading…');
  });

  it(`from ${BUSY_AFTER_MS / 60_000} minutes on says how long, and that the model may be busy`, () => {
    expect(extractionLabel(iv('running', '2026-10-23T11:58:00Z'), now)).toBe('Reading… 2 min — the model may still be busy with another request');
    expect(extractionLabel(iv('running', '2026-10-23T11:47:30Z'), now)).toMatch(/^Reading… 12 min/);
  });

  it('a finished run and an unknown status keep their own label', () => {
    expect(extractionLabel(iv('done', '2026-10-23T11:00:00Z'), now)).toBe('Read');
    expect(extractionLabel(iv('mystery', null), now)).toBe('mystery');
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

describe('relevance, membership and aliases', () => {
  it('folds only the low tier; a claim without a tier stays with the high ones, in the order given', () => {
    const list = [claim({ id: 'a', relevance: 'low' }), claim({ id: 'b' }), claim({ id: 'c', relevance: 'high' }), claim({ id: 'd', relevance: 'low' })];
    const { high, low } = byRelevance(list);
    expect(high.map(c => c.id)).toEqual(['b', 'c']);
    expect(low.map(c => c.id)).toEqual(['a', 'd']);
    expect(isLowRelevance(claim({ relevance: null }))).toBe(false);
    expect(byRelevance(null)).toEqual({ high: [], low: [] });
  });

  it('groups confirmed aliases on their own, and memberships with the people', () => {
    const g = groupConfirmed([
      claim({ id: 'al', claimKind: 'alias', status: 'confirmed', value: 'Port Co' }),
      claim({ id: 'm', claimKind: 'membership', status: 'edited', attribute: 'left', principalId: 'p-jan' }),
      claim({ id: 'mp', claimKind: 'membership', status: 'proposed', attribute: 'left' }),
    ]);
    expect(g.aliases.map(c => c.id)).toEqual(['al']);
    expect(g.people.map(c => c.id)).toEqual(['m']);
  });

  it('the folded summary counts facts, distinct people, and — for a writer — what is left to review', () => {
    const claims = [
      claim({ id: '1', claimKind: 'description', status: 'confirmed' }),
      claim({ id: '2', claimKind: 'role', status: 'confirmed', principalId: 'p-piet' }),
      claim({ id: '3', claimKind: 'roleHistory', status: 'edited', principalId: 'p-piet' }),
      claim({ id: '4', claimKind: 'membership', status: 'confirmed', subjectName: 'Karel' }),
      claim({ id: '5', claimKind: 'property', status: 'proposed' }),
      claim({ id: '6', claimKind: 'alias', status: 'rejected' }),
    ];
    expect(whatWeKnowSummary(claims, true)).toBe('4 facts · 2 people · 1 proposed to review');
    expect(whatWeKnowSummary(claims, false)).toBe('4 facts · 2 people');
    expect(whatWeKnowSummary([claim({ claimKind: 'role', status: 'confirmed', principalId: 'p' })], true)).toBe('1 fact · 1 person');
    expect(whatWeKnowSummary([], true)).toBe('0 facts · 0 people');
  });

  it('a claim as one line: who, what, and the relation or the membership status in words when it adds something', () => {
    expect(claimLine(claim({ claimKind: 'membership', subjectName: 'Jan Smit', attribute: 'left', value: 'went to another team' })))
      .toBe('Jan Smit — went to another team (left)');
    expect(claimLine(claim({ claimKind: 'membership', subjectName: 'Jan Smit', attribute: 'left', value: 'left' }))).toBe('Jan Smit — left');
    expect(claimLine(claim({ claimKind: 'membership', subjectName: 'Karel', attribute: 'former', value: 'early years' }))).toBe('Karel — early years (former member)');
    expect(claimLine(claim({ claimKind: 'role', subjectName: 'Piet', attribute: 'dayToDay', value: 'handles it' }))).toBe('Piet — handles it (does the day-to-day)');
    expect(claimLine(claim({ claimKind: 'roleHistory', subjectName: 'Piet', attribute: 'member', value: 'junior' }))).toBe('Piet — junior');
    expect(claimLine(claim({ claimKind: 'property', attribute: 'sector', value: 'ports' }))).toBe('sector: ports');
    expect(claimLine(claim({ claimKind: 'alias', value: 'PC' }))).toBe('PC');
  });

  it('the manual form sends a membership with its status, and needs the person', () => {
    const form = { kind: 'membership', value: 'left', subject: ' Jan ', relation: 'owner', membership: 'former', attribute: '', periodText: '', quote: '' };
    expect(manualClaimBody(form)).toEqual({ kind: 'membership', value: 'left', subject: 'Jan', membership: 'former' });
    expect(manualClaimReady({ ...form, subject: ' ' })).toBe(false);
    expect(manualClaimBody({ ...form, kind: 'role' }).membership).toBeUndefined();
  });
});
