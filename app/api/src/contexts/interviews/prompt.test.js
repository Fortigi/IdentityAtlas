// What the model is asked: a template-aware focus and a reply shape the rules can read.
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildUserMessage, RESPONSE_SCHEMA, INTERVIEWEE, MAX_CLAIMS_PER_PART } from './prompt.js';
import { CLAIM_KINDS, RELATIONS } from './claims.js';

describe('buildSystemPrompt', () => {
  it('an application is asked about purpose, users, data, owner and the daily work', () => {
    const p = buildSystemPrompt('LogicalApplication');
    expect(p).toMatch(/The subject is an application/);
    expect(p).toMatch(/users/);
    expect(p).not.toMatch(/organisational unit/);
  });

  it('a unit is asked about sector, contract since and role history; an unknown template reads as a unit', () => {
    const p = buildSystemPrompt('OrganizationalUnit');
    expect(p).toMatch(/customerSince/);
    expect(p).toMatch(/roleHistory, one claim per period/);
    expect(buildSystemPrompt(undefined)).toBe(p);
  });

  it('names the relation words and the interviewee word the rules read, and the two-claim rule for "not me, Y"', () => {
    const p = buildSystemPrompt('LogicalApplication');
    for (const r of RELATIONS) expect(p).toContain(`"${r}"`);
    expect(p).toContain(`"${INTERVIEWEE}"`);
    expect(p).toMatch(/notOwner for "interviewee" and owner for Y/);
  });
});

describe('buildUserMessage', () => {
  it('names the context, the interviewee and the date, and marks a part of a longer transcript', () => {
    const m = buildUserMessage({ contextName: 'Planner', template: 'LogicalApplication', intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01', part: 2, parts: 3, text: 'words' });
    expect(m.split('\n')).toEqual(['Application: "Planner"', 'Interviewee: "Anna Voorbeeld" (interviewed on 2026-10-01)', 'Transcript, part 2 of 3:', 'words']);
    expect(buildUserMessage({ contextName: 'Acme', template: 'OrganizationalUnit', intervieweeName: 'X', interviewedAt: 'd', text: 't' }))
      .toMatch(/^Unit: "Acme"[\s\S]*\nTranscript:\nt$/);
  });

  it('a file or pasted text names its source, and nobody as the speaker; an interview stays as it was', () => {
    const base = { contextName: 'Acme', template: 'OrganizationalUnit', intervieweeName: 'analyst@example.test', interviewedAt: '2026-10-02', text: 't' };
    expect(buildUserMessage({ ...base, sourceKind: 'file', fileName: 'team.csv', parts: 2 }).split('\n')).toEqual([
      'Unit: "Acme"', 'Source: the file "team.csv", added on 2026-10-02; nobody in particular is speaking', 'Text, part 1 of 2:', 't',
    ]);
    expect(buildUserMessage({ ...base, sourceKind: 'text' }).split('\n').slice(1, 3)).toEqual([
      'Source: text added on 2026-10-02; nobody in particular is speaking', 'Text:',
    ]);
    expect(buildUserMessage({ ...base, sourceKind: 'interview' }).split('\n')[1]).toBe('Interviewee: "analyst@example.test" (interviewed on 2026-10-02)');
    expect(buildSystemPrompt('OrganizationalUnit')).toMatch(/or another text about it: notes, a document, a list with one line per row/);
  });

  it('names the other names the context already has, so the model gives only new ones', () => {
    const m = buildUserMessage({ contextName: 'HarbourOfficeNL', aliases: ['HO', 'Haven'], template: 'OrganizationalUnit', intervieweeName: 'X', interviewedAt: 'd', text: 't' });
    expect(m.split('\n')[0]).toBe('Unit: "HarbourOfficeNL" (also known as "HO", "Haven")');
    expect(buildSystemPrompt('OrganizationalUnit')).toMatch(/is current, not former — read the whole sentence/);
  });
});

describe('RESPONSE_SCHEMA', () => {
  it('closes kind and relation to the lists the check knows and caps the claims per part', () => {
    const item = RESPONSE_SCHEMA.properties.claims.items;
    expect(item.properties.kind.enum).toEqual(CLAIM_KINDS);
    expect(item.properties.relation.enum).toEqual([...RELATIONS, null]);
    expect(item.required).toEqual(['kind', 'value', 'quote']);
    expect(RESPONSE_SCHEMA.properties.claims.maxItems).toBe(MAX_CLAIMS_PER_PART);
  });
});
