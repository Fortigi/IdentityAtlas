import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import { ruleFindings, modelFindings, directoryFindings, findingKey, MAX_UNCERTAIN_QUESTIONS } from './findings.js';

const mentions = [
  { key: 'person:taake', type: 'person', label: 'Taake' },
  { key: 'person:bakker', type: 'person', label: 'Bakker' },
  { key: 'team:it commissie', type: 'team', label: 'IT-commissie' },
  { key: 'person:rob', type: 'person', label: 'Rob' },
  { key: 'concept:vijf', type: 'concept', label: 'vijf mensen' },
];
const resolutions = new Map([
  ['person:taake', { status: 'unmatched', candidates: [] }],
  ['person:bakker', { status: 'ambiguous', candidates: [{ label: 'Anna Bakker', confidence: 79 }, { label: 'Tom Bakker', confidence: 79 }, { label: 'Bakkerij', confidence: 50 }] }],
  ['team:it commissie', { status: 'unmatched', candidates: [] }],
  ['person:rob', { status: 'candidates', candidates: [{ label: 'Rob Visser', confidence: 79 }] }],
  ['concept:vijf', { status: 'unmatched', candidates: [] }],
]);

describe('ruleFindings', () => {
  it('asks about unknown names, names a team without a group, lists the tied candidates only', () => {
    const f = ruleFindings({ mentions, resolutions, claims: [], language: 'nl' });
    expect(f.map(x => x.category)).toEqual(['unresolved-name', 'ambiguous-name', 'no-system-object']);
    expect(f[0].text).toContain('"Taake"');
    expect(f[1].text).toContain('Anna Bakker, Tom Bakker');
    expect(f[1].text).not.toContain('Bakkerij');
    expect(f[2].text).toContain('Welke groep, context of Teams-site hoort bij "IT-commissie"');
    expect(f.every(x => x.kind === 'question' && x.origin === 'rule')).toBe(true);
  });

  it('a concept never needs resolving and a resolved name raises nothing', () => {
    const f = ruleFindings({ mentions, resolutions, claims: [], language: 'nl' });
    expect(f.some(x => x.related.mentions.includes('concept:vijf') || x.related.mentions.includes('person:rob'))).toBe(false);
  });

  it('a self-correction is an issue; uncertain statements become at most a few questions', () => {
    const claims = [
      { key: 'c1', subject: 'Security Team', predicate: 'hasProperty', object: 'vijf mensen', modality: 'correction' },
      ...Array.from({ length: MAX_UNCERTAIN_QUESTIONS + 2 }, (_, i) => ({ key: `u${i}`, subject: 'Bakker', predicate: 'worksForCustomer', object: `K${i}`, modality: 'uncertain' })),
    ];
    const f = ruleFindings({ mentions: [], resolutions: new Map(), claims, language: 'en' });
    expect(f[0]).toMatchObject({ kind: 'issue', category: 'self-correction', related: { claims: ['c1'] } });
    expect(f[0].text).toMatch(/^The speaker corrects themselves/);
    expect(f.filter(x => x.category === 'uncertain-statement')).toHaveLength(MAX_UNCERTAIN_QUESTIONS);
  });
});

describe('modelFindings', () => {
  it('keeps only cited passages that exist', () => {
    expect(modelFindings([{ kind: 'issue', text: 'negen of tien?', passages: [1, 4] }], [{ seq: 1 }, { seq: 2 }])).toEqual([
      { kind: 'issue', category: 'model', text: 'negen of tien?', related: { passages: [1] }, origin: 'model' },
    ]);
  });
});

describe('directoryFindings', () => {
  const PERSON = { targetType: 'Identity', targetId: '00000000-0000-4000-8000-0000000000a1', label: 'Maria Novak', confidence: 100 };
  const GROUP = { targetType: 'Resource', targetId: '00000000-0000-4000-8000-0000000000b1', label: 'SG-Finance', confidence: 90 };
  const res = new Map([
    ['person:maria', { status: 'candidates', candidates: [PERSON] }],
    ['team:sg finance', { status: 'candidates', candidates: [GROUP] }],
    ['person:x', { status: 'ambiguous', candidates: [PERSON, { ...PERSON, targetId: 'other' }] }],
  ]);
  const claim = { key: 'k1', predicate: 'memberOf', subjectKey: 'person:maria', objectKey: 'team:sg finance', object: 'SG-Finance' };

  beforeEach(() => { query.mockReset(); });

  function stage({ principals = ['p1'], member = 0, members = 3 }) {
    query.mockImplementation(async (sql) => {
      if (sql.includes('IdentityMembers')) return { rows: principals.map(id => ({ id })) };
      if (sql.includes('count(DISTINCT')) return { rows: [{ n: members }] };
      return { rows: [{ n: member }] };
    });
  }

  it('says "not a member" as a question when the directory disagrees', async () => {
    stage({ member: 0, members: 1 });
    const f = await directoryFindings({ claims: [claim], resolutions: res, language: 'nl' });
    expect(f[0]).toMatchObject({ kind: 'question', category: 'directory-gap', related: { claims: ['k1'] } });
    expect(f[0].text).toContain('Maria Novak is geen lid van de groep "SG-Finance"');
    expect(f).toHaveLength(1); // 1 named, 1 member: no count question
  });

  it('no question when the person is a member; a count question when the numbers differ', async () => {
    stage({ member: 1, members: 3 });
    const f = await directoryFindings({ claims: [claim], resolutions: res, language: 'nl' });
    expect(f.map(x => x.category)).toEqual(['member-count']);
    expect(f[0].text).toContain('noemt 1 leden van "SG-Finance"; de gelijknamige groep heeft er 3');
  });

  it('never compares through an ambiguous or missing match', async () => {
    stage({});
    const f = await directoryFindings({ claims: [{ ...claim, subjectKey: 'person:x' }, { ...claim, objectKey: 'nope' }], resolutions: res, language: 'nl' });
    expect(query.mock.calls.some(([sql]) => sql.includes('IdentityMembers'))).toBe(false);
    expect(f.every(x => x.category === 'member-count')).toBe(true);
  });

  it('only memberOf statements are compared', async () => {
    stage({});
    expect(await directoryFindings({ claims: [{ ...claim, predicate: 'leads' }], resolutions: res, language: 'nl' })).toEqual([]);
  });
});

it('findingKey is stable and distinguishes kind, category and text', () => {
  const f = { kind: 'issue', category: 'model', text: 'a' };
  expect(findingKey(f)).toBe(findingKey({ ...f }));
  expect(findingKey(f)).not.toBe(findingKey({ ...f, kind: 'question' }));
  expect(findingKey(f)).not.toBe(findingKey({ ...f, text: 'b' }));
});
