// Another name of the context, proposed by rule when the model left it out.
import { describe, it, expect } from 'vitest';
import { aliasCandidates, aliasHintClaims, ALIAS_CONFIDENCE, MAX_HINTS } from './aliasHints.js';

const TRANSCRIPT = [
  'Interviewer: Vertel eens over de klant.',
  'Femke Voorbeeld: Het Havenkantoor is sinds 2019 klant bij ons. Het is een grote organisatie.',
  'Femke Voorbeeld: Voor het Havenkantoor doen we vooral IAM. Jan de Vries is daar mijn contact, en de Vries-familie kent iedereen.',
  'Femke Voorbeeld: We draaien op het Azure platform, en het Azure platform is groot. De Kustwacht doet iets vergelijkbaars, de Kustwacht ook.',
].join('\n');

const OPTS = { transcript: TRANSCRIPT, contextName: 'HarbourOfficeNL', intervieweeName: 'Femke Voorbeeld' };
const person = (subjectName) => ({ claimKind: 'role', subjectName, attribute: 'other', value: 'contact' });

describe('aliasCandidates', () => {
  it('proposes a name used twice with an article, quoted with the sentence it first stands in', () => {
    const [hit, ...rest] = aliasCandidates([], OPTS);
    expect(hit).toEqual({ name: 'Havenkantoor', norm: 'havenkantoor', quote: 'Het Havenkantoor is sinds 2019 klant bij ons.' });
    expect(rest.map(c => c.name)).toEqual(['Azure', 'Kustwacht']);
  });

  it('skips pronouns, a surname after a first name, a person a claim names, and a name a property gives', () => {
    const claims = [person('Kustwacht'), { claimKind: 'property', attribute: 'systems', value: 'Azure' }];
    expect(aliasCandidates(claims, OPTS).map(c => c.name)).toEqual(['Havenkantoor']);
  });

  it('skips the context\'s own name (spacing ignored), an alias it has, and one the model already gave', () => {
    expect(aliasCandidates([], { ...OPTS, contextName: 'Haven Kantoor', aliases: ['Azure'] }).map(c => c.name)).toEqual(['Kustwacht']);
    expect(aliasCandidates([{ claimKind: 'alias', value: 'Kustwacht' }], { ...OPTS, aliases: 'Azure' }).map(c => c.name)).toEqual(['Havenkantoor']);
  });

  it('a name said once counts only when the first description claim says it; a description may start with it', () => {
    const once = 'Femke: The Port Desk is our customer. We like them.\nFemke: The Tower people are nice.';
    const desc = (value, quote) => ({ claimKind: 'description', value, quote });
    expect(aliasCandidates([], { ...OPTS, transcript: once })).toEqual([]);
    const claims = [desc('A customer', 'We like them'), desc('Het is een klant', null), desc('Port Desk is a customer', 'The Port Desk is our customer'), desc('none', null)];
    expect(aliasCandidates(claims, { ...OPTS, transcript: once }).map(c => c.name)).toEqual(['Port Desk']);
    // A description led by a name that is never said gives no alias: there is nothing to quote.
    expect(aliasCandidates([desc('Ghost Unit is a customer', 'The Port Desk is our customer')], { ...OPTS, transcript: once }).map(c => c.name)).toEqual(['Port Desk']);
  });

  it('quotes the phrase when the sentence is too long, and nothing when even that is too short', () => {
    const long = `Femke: The Pier ${'and so on '.repeat(40)}. The Pier again.`;
    expect(aliasCandidates([], { ...OPTS, transcript: long })).toEqual([{ name: 'Pier', norm: 'pier', quote: 'The Pier' }]);
    const short = `Femke: de Ax ${'en zo '.repeat(60)}. de Ax weer.`;
    expect(aliasCandidates([], { ...OPTS, transcript: short })).toEqual([]);
  });

  it('nothing in an empty transcript', () => {
    expect(aliasCandidates([], { contextName: 'X', transcript: null })).toEqual([]);
  });
});

describe('aliasHintClaims', () => {
  it('drops another context\'s name and makes alias claims of confidence 0.5, high relevance, at most MAX_HINTS', () => {
    const cands = ['Een', 'Twee', 'Drie', 'Vier', 'Vijf'].map(n => ({ name: n, norm: n.toLowerCase(), quote: `Het ${n} is daar.` }));
    const out = aliasHintClaims(cands, ['Een']);
    expect(out).toHaveLength(MAX_HINTS);
    expect(out[0]).toMatchObject({ claimKind: 'alias', subjectKind: 'Context', value: 'Twee', quote: 'Het Twee is daar.', confidence: ALIAS_CONFIDENCE, relevance: 'high' });
    expect(aliasHintClaims(cands.slice(0, 1))).toHaveLength(1);
  });
});
