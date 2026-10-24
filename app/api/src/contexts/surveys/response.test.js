// A submitted survey as a source: the transcript reads as the survey did, and
// every answer that means something is one claim quoting its own line.
import { describe, it, expect } from 'vitest';
import { buildResponse, answerText } from './response.js';
import { SEED_TEMPLATES } from './seedTemplates.js';

const ANNA = 'aaaaaaaa-0000-4000-8000-000000000001';
const PIET = 'aaaaaaaa-0000-4000-8000-000000000002';
const KEES = 'aaaaaaaa-0000-4000-8000-000000000003';
const KIM = 'bbbbbbbb-0000-4000-8000-000000000001';
const TOM = 'bbbbbbbb-0000-4000-8000-000000000002';
const RES = 'cccccccc-0000-4000-8000-000000000001';

const seed = (key) => SEED_TEMPLATES.find(t => t.key === key).definition;
const respondent = { principalId: ANNA, identityId: null, name: 'Anna Voorbeeld' };
const opts = (over = {}) => ({ lang: 'en', contextName: 'Payroll', respondent, date: '2026-10-23', ...over });
// Every claim's quote is its span of the transcript.
const quotesHold = ({ transcript, claims }) => claims.every(c => transcript.slice(c.quoteStart, c.quoteEnd) === c.quote);

describe('buildResponse — application intake', () => {
  const def = seed('application-intake');

  it('"not me, Piet is; Kees does the work": a notOwner claim on the respondent, an owner claim on Piet (Accountable), Kees Responsible', () => {
    const r = buildResponse(def, {
      isOwner: 'no',
      realOwner: { principalId: PIET, displayName: 'Piet Jansen' },
      responsible: [{ principalId: KEES, displayName: 'Kees Bakker' }],
      criticality: 'B',
      nis2: 'yes',
      purpose: 'Pays   the\nstaff.',
    }, opts());
    expect(r.transcript.split('\n')).toEqual([
      'Survey: Application intake: Payroll',
      'Answered by: Anna Voorbeeld, 2026-10-23',
      '',
      'Ownership',
      'Are you the owner of this application, Payroll?: No',
      'Who is the owner, then?: Piet Jansen',
      'Who does the day-to-day work for it?: Kees Bakker',
      '',
      'Classification',
      'How critical is Payroll?: B: severe impact within a day',
      'Is Payroll relevant for NIS2?: Yes',
      'What is Payroll used for?: Pays the staff.',
    ]);
    const brief = r.claims.map(c => [c.surveyQuestionId, c.claimKind, c.subjectKind, c.principalId, c.attribute, c.value, c.roleSuggestion, c.subjectMatch]);
    expect(brief).toEqual([
      ['isOwner', 'role', 'Person', ANNA, 'notOwner', 'Are you the owner of this application, Payroll?: No', null, 'interviewee'],
      ['realOwner', 'role', 'Person', PIET, 'owner', 'Who is the owner, then?: Piet Jansen', 'Accountable', 'key'],
      ['responsible', 'role', 'Person', KEES, 'dayToDay', 'Who does the day-to-day work for it?: Kees Bakker', 'Responsible', 'key'],
      ['criticality', 'property', 'Context', undefined, 'criticality', 'B', null, undefined],
      ['nis2', 'property', 'Context', undefined, 'nis2Relevant', 'yes', null, undefined],
      ['purpose', 'description', 'Context', undefined, null, 'Pays the staff.', null, undefined],
    ]);
    expect(r.claims.every(c => c.confidence === 1 && c.relevance === 'high')).toBe(true);
    expect(quotesHold(r)).toBe(true);
  });

  it('"yes, I am the owner" suggests the respondent as Accountable; an unanswered question says nothing', () => {
    const r = buildResponse(def, { isOwner: 'yes', criticality: 'A' }, opts());
    expect(r.claims.map(c => [c.surveyQuestionId, c.attribute, c.roleSuggestion])).toEqual([
      ['isOwner', 'owner', 'Accountable'],
      ['criticality', 'criticality', null],
    ]);
    expect(r.transcript).not.toMatch(/NIS2/);
  });

  it('speaks the respondent\'s language in the transcript, and keeps the stable value in a property', () => {
    const r = buildResponse(def, { isOwner: 'yes', criticality: 'A' }, opts({ lang: 'nl' }));
    expect(r.transcript).toMatch(/^Vragenlijst: Intake applicatie: Payroll\nBeantwoord door: Anna Voorbeeld, 2026-10-23\n\nEigenaarschap\nBent u de eigenaar van de applicatie Payroll\?: Ja\n/);
    expect(r.transcript).toMatch(/Hoe kritiek is Payroll\?: A: het bedrijf stopt zonder$/);
    expect(r.claims[1].value).toBe('A');
  });

  it('names nobody when the recipient\'s account is gone: no claim about the respondent', () => {
    const r = buildResponse(def, { isOwner: 'yes' }, opts({ respondent: { principalId: null, identityId: null, name: 'Anna' } }));
    expect(r.claims).toEqual([]);
  });
});

describe('buildResponse — per row', () => {
  it('a unit roster: one membership claim per member, and the role and responsibility in the respondent\'s words', () => {
    const rows = [
      { id: KIM, kind: 'Principal', displayName: 'Kim Los', columns: {} },
      { id: TOM, kind: 'Identity', displayName: 'Thom Oskam', columns: {} },
    ];
    const r = buildResponse(seed('unit-roster'), {
      worksHere: { [KIM]: 'yes', [TOM]: 'no' },
      role: { [KIM]: 'Data scientist' },
      responsibleFor: { [KIM]: 'Route scanner' },
    }, opts({ contextName: 'Team Innovation', rows: { worksHere: rows, role: rows, responsibleFor: rows } }));
    expect(r.transcript).toMatch(/Works for you\? \(Kim Los\): Yes\nWorks for you\? \(Thom Oskam\): No\nRole \(Kim Los\): Data scientist\nResponsible for \(Kim Los\): Route scanner$/);
    expect(r.claims.map(c => [c.claimKind, c.principalId, c.identityId, c.attribute, c.value])).toEqual([
      ['membership', KIM, null, 'current', 'Works for you? (Kim Los): Yes'],
      ['membership', null, TOM, 'former', 'Works for you? (Thom Oskam): No'],
      ['role', KIM, null, 'member', 'Data scientist'],
      ['role', KIM, null, 'other', 'Route scanner'],
    ]);
    expect(r.claims.every(c => c.roleSuggestion === null)).toBe(true);
    expect(quotesHold(r)).toBe(true);
  });

  it('an entitlement review: a confirmed owner states the owner we have; a corrected one states the right one — about the resource', () => {
    const rows = [{ id: RES, kind: 'Resource', displayName: 'Payroll admins', columns: { owner: 'Piet Jansen', certificationFrequency: 'yearly' } }];
    const r = buildResponse(seed('application-entitlement-review'), {
      entitlementOwner: { [RES]: { ok: true } },
      certificationFrequency: { [RES]: { ok: false, value: 'quarterly' } },
    }, opts({ rows: { entitlementOwner: rows, certificationFrequency: rows } }));
    expect(r.transcript).toMatch(/Is the owner of this entitlement right\? \(Payroll admins\): Yes, correct \(Piet Jansen\)\nIs the certification frequency right\? \(Payroll admins\): No, it should be: quarterly$/);
    expect(r.claims.map(c => [c.subjectKind, c.resourceId, c.subjectName, c.attribute, c.value])).toEqual([
      ['Resource', RES, 'Payroll admins', 'owner', 'Piet Jansen'],
      ['Resource', RES, 'Payroll admins', 'certificationFrequency', 'quarterly'],
    ]);
  });

  it('confirming an empty value states nothing', () => {
    const rows = [{ id: RES, kind: 'Resource', displayName: 'Payroll admins', columns: { owner: null } }];
    const r = buildResponse(seed('application-entitlement-review'), { entitlementOwner: { [RES]: { ok: true } } }, opts({ rows: { entitlementOwner: rows } }));
    expect(r.transcript).toMatch(/\(Payroll admins\): Yes, correct$/);
    expect(r.claims).toEqual([]);
  });
});

describe('buildResponse — other shapes', () => {
  const def = (questions) => ({ schemaVersion: 1, languages: ['en'], title: 'Check', sections: [{ id: 's', questions }] });

  it('a choice mapped to statuses: an unmapped value says nothing; a question without becomes is only transcript', () => {
    const d = def([
      { id: 'a', text: 'Status', answer: { type: 'choice', options: [{ value: 'in' }, { value: 'out' }, { value: 'unsure' }] },
        becomes: { kind: 'role', about: 'respondent', relation: { in: 'member' } } },
      { id: 'b', text: 'Anything else', answer: { type: 'text' } },
    ]);
    expect(buildResponse(d, { a: 'unsure', b: 'No' }, opts()).claims).toEqual([]);
    expect(buildResponse(d, { a: 'in' }, opts()).claims.map(c => c.attribute)).toEqual(['member']);
  });

  it('a context-level confirm shows the context\'s current value; multi-choice, date and people as properties', () => {
    const d = def([
      { id: 'c', text: 'Is the criticality right?', answer: { type: 'confirm', shows: 'criticality' }, becomes: { kind: 'property', attribute: 'criticality' } },
      { id: 'm', text: 'Regions', answer: { type: 'multiChoice', options: [{ value: 'EU' }, { value: 'US' }] }, becomes: { kind: 'property', attribute: 'regions' } },
      { id: 'd', text: 'Since', answer: { type: 'date' }, becomes: { kind: 'property', attribute: 'since' } },
      { id: 'p', text: 'Contacts', answer: { type: 'people' }, becomes: { kind: 'property', attribute: 'contacts' } },
      { id: 'o', text: 'Lead', answer: { type: 'person' }, becomes: { kind: 'property', attribute: 'lead' } },
      { id: 'x', text: 'Also called', answer: { type: 'text' }, becomes: { kind: 'alias' } },
    ]);
    const r = buildResponse(d, {
      c: { ok: true }, m: ['US', 'EU'], d: '2020-01-01',
      p: [{ principalId: PIET, displayName: 'Piet' }, { principalId: KEES, displayName: 'Kees' }],
      o: { principalId: PIET, displayName: 'Piet' }, x: 'PAY',
    }, opts({ contextValues: { criticality: 'B' } }));
    expect(r.claims.map(c => [c.claimKind, c.attribute, c.value])).toEqual([
      ['property', 'criticality', 'B'], ['property', 'regions', 'US, EU'], ['property', 'since', '2020-01-01'],
      ['property', 'contacts', 'Piet, Kees'], ['property', 'lead', 'Piet'], ['alias', null, 'PAY'],
    ]);
    expect(r.transcript).toMatch(/Is the criticality right\?: Yes, correct \(B\)/);
  });

  it('a long answer is quoted up to the quote limit, its span still in the transcript', () => {
    const d = def([{ id: 't', text: 'What', answer: { type: 'text' }, becomes: { kind: 'description' } }]);
    const r = buildResponse(d, { t: 'x'.repeat(1500) }, opts());
    expect(r.claims[0].quote).toHaveLength(1000);
    expect(r.claims[0].value).toHaveLength(1500);
    expect(quotesHold(r)).toBe(true);
  });
});

describe('answerText', () => {
  it('falls back to the value for an unknown option and to English for an unknown language', () => {
    const q = { answer: { type: 'choice', options: [{ value: 'A', label: 'Alpha' }] } };
    expect(answerText(q, 'Z', { lang: 'en' })).toBe('Z');
    expect(answerText({ answer: { type: 'yesNo' } }, 'yes', { lang: 'de' })).toBe('Yes');
    expect(answerText({ answer: { type: 'person' } }, { principalId: PIET }, { lang: 'en' })).toBe(PIET);
  });
});
