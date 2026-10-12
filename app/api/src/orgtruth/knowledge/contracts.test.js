import { describe, it, expect } from 'vitest';
import {
  checkTopic, checkMentions, checkClaims, checkVerdict, checkFindings, LIMITS, MENTION_ENTITY_TYPES, isMentionEntityType,
  CLAIM_SCHEMA, SINGLE_SCHEMA, PREDICATES, MENTION_TYPES,
} from './contracts.js';

describe('stage validators', () => {
  it('topic: one of the closed list', () => {
    expect(checkTopic({ topic: 'governance' })).toEqual({ ok: true, value: 'governance' });
    expect(checkTopic({ topic: 'sports' }).ok).toBe(false);
    expect(checkTopic(null).ok).toBe(false);
  });

  it('mentions: keeps the valid ones, cleans labels, fails only when nothing is usable', () => {
    const r = checkMentions({ mentions: [{ text: '  Contoso Retail. ', type: 'customer' }, { text: 'x', type: 'planet' }, { text: '', type: 'person' }] });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual([{ text: 'Contoso Retail', type: 'customer' }]);
    expect(r.errors).toHaveLength(2);
    expect(checkMentions({ mentions: [{ text: 'x', type: 'planet' }] }).ok).toBe(false);
    expect(checkMentions({ mentions: [] })).toEqual({ ok: true, value: [], errors: [] });
    expect(checkMentions({}).ok).toBe(false);
  });

  it('mentions: never more than the per-passage cap', () => {
    const many = Array.from({ length: LIMITS.mentionsPerPassage + 5 }, (_, i) => ({ text: `P${i}`, type: 'person' }));
    expect(checkMentions({ mentions: many }).value).toHaveLength(LIMITS.mentionsPerPassage);
  });

  it('claims: subject, object, allowed predicate and modality, non-empty quote', () => {
    const good = { subject: 'Rob', predicate: 'memberOf', object: 'Omada-kernteam', modality: 'stated', quote: 'Led, Rob, Mark en Taake' };
    expect(checkClaims({ claims: [good] }).value).toEqual([{ ...good, qualifier: null }]);
    const bad = [
      { ...good, predicate: 'isFriendOf' }, { ...good, modality: 'guess' }, { ...good, quote: ' ' }, { ...good, subject: '' },
    ];
    const r = checkClaims({ claims: [good, ...bad] });
    expect(r.value).toHaveLength(1);
    expect(r.errors).toHaveLength(4);
    expect(checkClaims({ claims: bad }).ok).toBe(false);
  });

  it('claims: the cap is a parameter (the single-prompt baseline reads more)', () => {
    const c = { subject: 'A', predicate: 'other', object: 'B', modality: 'stated', quote: 'A is B always' };
    const many = Array.from({ length: 30 }, () => c);
    expect(checkClaims({ claims: many }).value).toHaveLength(LIMITS.claimsPerPassage);
    expect(checkClaims({ claims: many }, LIMITS.claimsSingle).value).toHaveLength(30);
  });

  it('verdict and findings', () => {
    expect(checkVerdict({ verdict: 'unclear' })).toEqual({ ok: true, value: 'unclear' });
    expect(checkVerdict({ verdict: 'maybe' }).ok).toBe(false);
    const f = checkFindings({ findings: [{ kind: 'issue', text: 'negen of tien?', passages: [1, 1, 9, 0, 2.5] }] }, 3);
    expect(f.value).toEqual([{ kind: 'issue', text: 'negen of tien?', passages: [1] }]);
    expect(checkFindings({ findings: [{ kind: 'note', text: 'x', passages: [] }] }, 3).ok).toBe(false);
  });
});

describe('schemas and types', () => {
  it('the single-prompt schema is the claim schema with a larger cap', () => {
    expect(SINGLE_SCHEMA.properties.claims.items).toBe(CLAIM_SCHEMA.properties.claims.items);
    expect(SINGLE_SCHEMA.properties.claims.maxItems).toBe(LIMITS.claimsSingle);
    expect(CLAIM_SCHEMA.properties.claims.items.properties.predicate.enum).toEqual(PREDICATES);
  });

  it('a mention is stored under a prefixed type no list can have by accident', () => {
    expect(MENTION_ENTITY_TYPES.person).toBe('Mentioned person');
    expect(Object.keys(MENTION_ENTITY_TYPES)).toEqual(MENTION_TYPES);
    expect(isMentionEntityType('Mentioned customer')).toBe(true);
    expect(isMentionEntityType('Klant')).toBe(false);
  });
});
