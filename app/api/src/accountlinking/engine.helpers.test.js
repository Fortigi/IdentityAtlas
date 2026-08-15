// Unit tests for the pure account-linking engine helpers (no DB).
//
// These cover the indexing / candidate-collection / aggregation building blocks
// factored out of engine.js, including branches the buildLinks/runLinking tests
// don't exercise directly (empty-key skipping, prefix-stripped candidate hits,
// and merging several links onto one identity).

import { describe, it, expect } from 'vitest';
import {
  norm,
  fullName,
  personName,
  prefixesFrom,
  suffixesFrom,
  nameSignalNames,
  indexIdentities,
  collectCandidates,
  aggregateByIdentity,
} from './engine.helpers.js';
import { DEFAULT_RULES } from './defaultRules.js';

describe('norm', () => {
  it('lower-cases and trims a scalar', () => {
    expect(norm('  ADM-JDoe  ')).toBe('adm-jdoe');
  });
  it('maps null/undefined to the empty string', () => {
    expect(norm(null)).toBe('');
    expect(norm(undefined)).toBe('');
  });
});

describe('fullName', () => {
  it('joins givenName + surname into a normalised token', () => {
    expect(fullName({ givenName: 'John', surname: 'Doe' })).toBe('johndoe');
  });
  it('skips missing parts', () => {
    expect(fullName({ surname: 'Doe' })).toBe('doe');
  });
});

describe('personName', () => {
  it('parses "Surname, Given" into a comparable key', () => {
    const a = personName({ displayName: 'Euson, Robin (OGD)' });
    const b = personName({ displayName: '(ADM-azure) Euson, Robin' });
    expect(a.key).toBe(b.key);
    expect(a.surname).toBe('euson');
    expect(a.given).toBe('robin');
  });
});

describe('signal extractors', () => {
  it('prefixesFrom pulls stripPrefixes from the prefix signal', () => {
    expect(prefixesFrom(DEFAULT_RULES)).toContain('adm-');
  });
  it('suffixesFrom returns [] when no fuzzy signal exists', () => {
    expect(suffixesFrom(DEFAULT_RULES)).toEqual([]);
  });
  it('nameSignalNames returns the set of name-signal names', () => {
    const set = nameSignalNames(DEFAULT_RULES);
    expect(set.has('fullName')).toBe(true);
    expect(set.has('surnameInitial')).toBe(true);
    expect(set.has('employeeId')).toBe(false);
  });
  it('all extractors tolerate rules without a signals array', () => {
    expect(prefixesFrom({})).toEqual([]);
    expect(suffixesFrom({})).toEqual([]);
    expect(nameSignalNames({}).size).toBe(0);
  });
});

describe('indexIdentities', () => {
  it('indexes by employeeId, email-local, name and name-key', () => {
    const idy = { id: 'i1', displayName: 'Doe, John', email: 'jdoe@contoso.com', employeeId: 'E1' };
    const { byEmployeeId, byEmailLocal, byName, byNameKey } = indexIdentities([idy]);
    expect(byEmployeeId.get('e1')).toEqual([idy]);
    expect(byEmailLocal.get('jdoe')).toEqual([idy]);
    expect(byName.get('doejohn')).toEqual([idy]);
    expect(byNameKey.get(personName(idy).key)).toEqual([idy]);
  });
  it('skips empty keys (no employeeId / no email)', () => {
    const idy = { id: 'i2', displayName: '', email: '', employeeId: '' };
    const { byEmployeeId, byEmailLocal } = indexIdentities([idy]);
    expect(byEmployeeId.size).toBe(0);
    expect(byEmailLocal.size).toBe(0);
  });
  it('groups multiple identities under a shared key', () => {
    const a = { id: 'a', displayName: 'Jansen, Jan', email: 'jan.jansen@x.com' };
    const b = { id: 'b', displayName: 'Jansen, Jan', email: 'j.jansen@y.com' };
    const { byNameKey } = indexIdentities([a, b]);
    expect(byNameKey.get(personName(a).key)).toEqual([a, b]);
  });
});

describe('collectCandidates', () => {
  const indexes = indexIdentities([
    { id: 'byId',   displayName: 'A A', email: 'aa@x.com', employeeId: 'E7' },
    { id: 'byMail', displayName: 'B B', email: 'jdoe@contoso.com' },
    { id: 'byName', displayName: 'Doe, John', email: 'zzz@nowhere.com' },
  ]);
  const opts = { prefixes: prefixesFrom(DEFAULT_RULES), suffixes: suffixesFrom(DEFAULT_RULES) };

  it('collects across employeeId, email and name indexes, deduped by id', () => {
    const orphan = { id: 'o', displayName: 'Doe, John', email: 'jdoe@contoso.com', employeeId: 'E7' };
    const ids = [...collectCandidates(orphan, indexes, opts).keys()].sort();
    expect(ids).toEqual(['byId', 'byMail', 'byName']);
  });
  it('matches on the prefix-stripped email local part', () => {
    const orphan = { id: 'adm', displayName: 'X', email: 'adm-jdoe@contoso.com' };
    const ids = [...collectCandidates(orphan, indexes, opts).keys()];
    expect(ids).toContain('byMail'); // adm-jdoe → jdoe after stripping 'adm-'
  });
  it('returns an empty map when nothing matches', () => {
    const orphan = { id: 'none', displayName: 'Nobody Here', email: 'nobody@void.com' };
    expect(collectCandidates(orphan, indexes, opts).size).toBe(0);
  });
});

describe('aggregateByIdentity', () => {
  it('keeps the best confidence and the union of signals per identity', () => {
    const links = [
      { identityId: 'x', confidence: 60, signals: ['fullName'] },
      { identityId: 'x', confidence: 80, signals: ['emailPrefix', 'fullName'] },
      { identityId: 'y', confidence: 95, signals: ['employeeId'] },
    ];
    const agg = aggregateByIdentity(links);
    expect(agg.get('x').conf).toBe(80);
    expect([...agg.get('x').signals].sort()).toEqual(['emailPrefix', 'fullName']);
    expect(agg.get('y').conf).toBe(95);
  });
  it('returns an empty map for no links', () => {
    expect(aggregateByIdentity([]).size).toBe(0);
  });
});
