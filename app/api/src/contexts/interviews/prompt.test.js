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
