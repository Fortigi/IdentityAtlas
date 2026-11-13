import { describe, it, expect } from 'vitest';
import {
  sourceLabel, subjectLabel, isUncertainMatch, periodLabel, groupConfirmed, proposedClaims, roleSuggestions,
  anyInProgress, aliasFacts, sourcesSummary, needsPerson, isPersonClaim, SOURCE_KIND_LABELS, manualClaimBody, manualClaimReady, extractionLabel, BUSY_AFTER_MS,
  byRelevance, whatWeKnowSummary, claimLine, isLowRelevance, isLowConfidence, LOW_CONFIDENCE,
  groupKnowledge, knowledgeName, knowledgeCounts, reviewableHere, isKnowledgeClaim,
} from './claims.helpers';

const claim = (over) => ({ id: over.id ?? 'c', claimKind: 'role', status: 'proposed', intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01', ...over });

describe('labels', () => {
  it('names the source by its kind: an interview by who, a file by its name, pasted text by who added it', () => {
    expect(sourceLabel(claim({ sourceKind: 'interview', fileName: 'talk.vtt' }))).toBe('interview with Anna Voorbeeld, 2026-10-01');
    expect(sourceLabel(claim({ sourceKind: 'file', fileName: 'team.xlsx', intervieweeName: 'analyst@example.test' }))).toBe('team.xlsx, 2026-10-01');
    expect(sourceLabel(claim({ sourceKind: 'text', fileName: 'Pasted text', intervieweeName: 'analyst@example.test' }))).toBe('notes added by analyst@example.test, 2026-10-01');
    expect(SOURCE_KIND_LABELS).toEqual({ interview: 'Interview', file: 'File', text: 'Pasted text' });
  });

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

  it('groups the confirmed and edited claims about the unit; proposed, rejected and people\'s stay out', () => {
    const g = groupConfirmed(claims);
    expect(Object.keys(g)).toEqual(['description', 'properties', 'aliases']);
    expect([g.description, g.properties, g.aliases].map(l => l.map(c => c.id))).toEqual([['d'], ['p'], []]);
    expect(groupConfirmed(undefined)).toEqual({ description: [], properties: [], aliases: [] });
  });

  it('a claim about a person is a role, history or membership claim', () => {
    expect(['role', 'roleHistory', 'membership', 'property', 'alias', 'description'].map(k => isPersonClaim({ claimKind: k })))
      .toEqual([true, true, true, false, false, false]);
    expect(isPersonClaim(null)).toBe(false);
  });

  it('a role claim that would set a role for nobody we hold needs the person first', () => {
    expect(needsPerson(claim({ roleSuggestion: 'Accountable' }))).toBe(true);
    expect(needsPerson(claim({ roleSuggestion: 'Accountable', principalId: 'p' }))).toBe(false);
    expect(needsPerson(claim({ roleSuggestion: 'Accountable', identityId: 'i' }))).toBe(false);
    expect(needsPerson(claim({ roleSuggestion: null }))).toBe(false);
    expect(needsPerson(claim({ claimKind: 'roleHistory', roleSuggestion: 'Responsible' }))).toBe(false);
  });

  it('suggests a role from proposed role claims only', () => {
    expect(proposedClaims(claims).map(c => c.id)).toEqual(['q', 'a', 'n']);
    expect(roleSuggestions(claims, 'Responsible').map(c => c.id)).toEqual(['q']);
    expect(roleSuggestions(claims, 'Accountable').map(c => c.id)).toEqual(['a']);
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

  it('groups confirmed aliases on their own; a membership is no fact about the unit', () => {
    const g = groupConfirmed([
      claim({ id: 'al', claimKind: 'alias', status: 'confirmed', value: 'Port Co' }),
      claim({ id: 'm', claimKind: 'membership', status: 'edited', attribute: 'left', principalId: 'p-jan' }),
    ]);
    expect(g.aliases.map(c => c.id)).toEqual(['al']);
    expect(Object.values(g).flat().map(c => c.id)).toEqual(['al']);
  });

  it('the folded summary: the start of the description, then properties, other names and — for a writer — the unit\'s own review', () => {
    const claims = [
      claim({ id: '1', claimKind: 'property', status: 'confirmed' }),
      claim({ id: '2', claimKind: 'property', status: 'edited' }),
      claim({ id: '3', claimKind: 'role', status: 'proposed', principalId: 'p-piet' }),
      claim({ id: '4', claimKind: 'property', status: 'proposed' }),
      claim({ id: '5', claimKind: 'alias', status: 'proposed' }),
    ];
    const description = `A harbour office  that handles ${'x'.repeat(80)}`;
    const line = whatWeKnowSummary({ description, claims, aliases: ['HA', 'Haven'], canWrite: true });
    // 80 characters at most for the description, the spaces folded, then the counts.
    expect(line).toBe(`A harbour office that handles ${'x'.repeat(49)}… · 2 properties · also known as HA, Haven · 2 to review`);
    expect(whatWeKnowSummary({ description: 'Short.', claims, canWrite: false })).toBe('Short. · 2 properties');
    expect(whatWeKnowSummary({ claims: [claims[0]], canWrite: true })).toBe('1 property');
    expect(whatWeKnowSummary({ claims: [], canWrite: true })).toBe('Nothing recorded yet');
  });

  it('the sources line: how many and the latest date, or that nothing was added', () => {
    expect(sourcesSummary([{ interviewedAt: '2026-10-01' }, { interviewedAt: '2026-10-23' }, { interviewedAt: null }])).toBe('3 sources · latest 2026-10-23');
    expect(sourcesSummary([{ interviewedAt: '2026-10-01' }])).toBe('1 source · latest 2026-10-01');
    expect(sourcesSummary([{}])).toBe('1 source');
    expect(sourcesSummary(undefined)).toBe('Nothing added yet');
  });

  it('the other names: stored aliases and confirmed claims solid, then a writer\'s proposed ones; one per name', () => {
    const alias = (id, value, status) => claim({ id, claimKind: 'alias', value, status });
    const unit = { extendedAttributes: { aliases: ['HO'] } };
    const claims = [alias('a1', 'Havenkantoor', 'proposed'), alias('a2', 'Kade', 'confirmed'), alias('a3', 'h.o.', 'proposed'), alias('a4', 'Gone', 'rejected'), alias('a5', 'Kádé', 'edited')];
    expect(aliasFacts(unit, claims, true).map(f => [f.name, f.status, f.claim?.id ?? null])).toEqual([
      ['HO', 'confirmed', null], ['Kade', 'confirmed', 'a2'], ['Havenkantoor', 'proposed', 'a1'],
    ]);
    expect(aliasFacts(unit, claims, false).map(f => f.name)).toEqual(['HO', 'Kade']);
    expect(aliasFacts({ extendedAttributes: { aliases: 'not a list' } }, [], true)).toEqual([]);
    expect(aliasFacts(null, null, true)).toEqual([]);
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

describe('what the unit\'s people do, know and hold', () => {
  const k = (over) => claim({ status: 'confirmed', subjectDisplayName: 'Piet', ...over });
  const claims = [
    k({ id: 'a2', claimKind: 'activity', subjectDisplayName: 'Yara', value: 'Plan shifts' }),
    k({ id: 'a1', claimKind: 'activity', value: 'Plan shifts', objectName: 'Shift planning' }),
    k({ id: 'a0', claimKind: 'activity', value: 'Audit rosters' }),
    k({ id: 'e1', claimKind: 'expertise', status: 'edited', value: 'Rostering law' }),
    k({ id: 'd1', claimKind: 'duty', status: 'proposed', value: 'Fire warden' }),
    k({ id: 'd2', claimKind: 'duty', status: 'rejected', value: 'First aid' }),
    k({ id: 'r1', claimKind: 'role', status: 'proposed' }),
    k({ id: 'p1', claimKind: 'property', status: 'proposed' }),
  ];

  it('groups the confirmed and edited ones by kind, by person then name', () => {
    const g = groupKnowledge(claims);
    expect(g.activity.map(c => c.id)).toEqual(['a0', 'a1', 'a2']);
    expect(g.expertise.map(c => c.id)).toEqual(['e1']);
    expect(g.duty).toEqual([]);
    expect(groupKnowledge(undefined)).toEqual({ activity: [], expertise: [], duty: [] });
  });

  it('names a claim by the object it was linked to, else its value', () => {
    expect(knowledgeName(claims[1])).toBe('Shift planning');
    expect(knowledgeName(claims[0])).toBe('Plan shifts');
    expect(knowledgeName({})).toBe('');
  });

  it('counts the kinds that have any, singular and plural', () => {
    expect(knowledgeCounts(groupKnowledge(claims))).toBe('3 activities · 1 expertise');
    expect(knowledgeCounts(groupKnowledge([k({ id: 'x', claimKind: 'duty' }), k({ id: 'y', claimKind: 'activity' })]))).toBe('1 activity · 1 duty');
    expect(knowledgeCounts(groupKnowledge([k({ id: 'x', claimKind: 'duty' }), k({ id: 'y', claimKind: 'duty' })]))).toBe('2 duties');
    expect(knowledgeCounts(groupKnowledge([]))).toBe('');
  });

  it('reviews a knowledge claim here, a person\'s role on their row', () => {
    expect(reviewableHere(claims).map(c => c.id)).toEqual(['d1', 'p1']);
    expect(isKnowledgeClaim({ claimKind: 'expertise' })).toBe(true);
    expect(isKnowledgeClaim({ claimKind: 'role' })).toBe(false);
    expect(isKnowledgeClaim(null)).toBe(false);
  });

  it('puts the counts in the folded summary, before the review', () => {
    expect(whatWeKnowSummary({ claims, canWrite: true })).toBe('3 activities · 1 expertise · 2 to review');
    expect(whatWeKnowSummary({ claims, canWrite: false })).toBe('3 activities · 1 expertise');
  });
});
