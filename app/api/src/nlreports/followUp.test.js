// Carrying one answer into the next question.
//
// The thing under test is not cleverness, it is RESTRAINT. Two failures matter
// and they are not symmetric: missing a follow-up costs a rephrase, while
// silently narrowing an unrelated question to a set of 27 groups it was never
// about produces a confident, well-formatted, wrong answer — and the caller has
// no way to see it happened. So most of these tests are about the cases where
// nothing should be carried.

import { describe, it, expect } from 'vitest';
import {
  carriedRecords, carryForward, narrowToPrevious, previousContextBlock, refersToPrevious, substitutePrevious,
  usedPrevious, MAX_CARRIED,
} from './followUp.js';
import { MAX_CONDITIONS, PREVIOUS_SENTINEL } from './spec.js';

const group = (id, name) => ({ id, name, kind: 'resource' });

describe('what an answer leaves behind to refer to', () => {
  it('takes the rows themselves when the answer is a list of records', () => {
    // "Welke groepen hebben geen eigenaar?" — one row per group.
    const carried = carriedRecords({
      rows: [
        { displayName: 'ASML', _entity: { kind: 'resource', id: 'g1' } },
        { displayName: 'Bestuur', _entity: { kind: 'resource', id: 'g2' } },
      ],
    });
    expect(carried.kind).toBe('resource');
    expect(carried.records.map(r => r.id)).toEqual(['g1', 'g2']);
  });

  it('takes the listed records when the answer is one row listing many', () => {
    // "Van welke groepen ben ik owner?" — ONE row, the caller's own account,
    // with 27 groups in a cell. The account is a container; the groups are what
    // the caller is looking at and what "deze groepen" means.
    const carried = carriedRecords({
      rows: [{
        displayName: 'Wim',
        _entity: { kind: 'user', id: 'me' },
        _links: { 'owns.names': [group('g1', 'ASML'), group('g2', 'Bestuur')] },
      }],
    });
    expect(carried.kind).toBe('resource');
    expect(carried.records.map(r => r.id)).toEqual(['g1', 'g2']);
  });

  it('prefers the rows over a list inside them when there are many rows', () => {
    // A report of 2 groups that also lists their members is about the GROUPS.
    const carried = carriedRecords({
      rows: [
        { _entity: { kind: 'resource', id: 'g1' }, _links: { 'members.names': [{ id: 'u1', name: 'A', kind: 'user' }, { id: 'u2', name: 'B', kind: 'user' }, { id: 'u3', name: 'C', kind: 'user' }] } },
        { _entity: { kind: 'resource', id: 'g2' }, _links: { 'members.names': [{ id: 'u4', name: 'D', kind: 'user' }] } },
      ],
    });
    expect(carried.kind).toBe('resource');
    expect(carried.records.map(r => r.id)).toEqual(['g1', 'g2']);
  });

  it('takes the biggest list when one row carries several', () => {
    const carried = carriedRecords({
      rows: [{
        _entity: { kind: 'user', id: 'me' },
        _links: {
          'memberOf.names': [group('g1'), group('g2'), group('g3')],
          'owns.names': [group('g9')],
        },
      }],
    });
    expect(carried.records.map(r => r.id)).toEqual(['g1', 'g2', 'g3']);
  });

  it('falls back to the single record when one row lists nothing', () => {
    const carried = carriedRecords({ rows: [{ displayName: 'ASML', _entity: { kind: 'resource', id: 'g1' } }] });
    expect(carried).toEqual({ kind: 'resource', records: [{ id: 'g1', name: null }] });
  });

  it('carries nothing from an answer that matched nothing', () => {
    expect(carriedRecords({ rows: [] })).toBe(null);
    expect(carriedRecords({})).toBe(null);
    expect(carriedRecords(null)).toBe(null);
  });

  it('counts a record once however often it is listed', () => {
    const carried = carriedRecords({
      rows: [{ _entity: { kind: 'user', id: 'me' }, _links: { a: [group('g1'), group('g1'), group('g2')] } }],
    });
    expect(carried.records.map(r => r.id)).toEqual(['g1', 'g2']);
  });

  it('carries nothing at all when the answer is bigger than the cap', () => {
    // Not "the first 200": a follow-up to a truncated set would answer about
    // part of what the caller asked and say nothing about the rest. Carrying
    // nothing makes the next question stand on its own, which is honest.
    const many = Array.from({ length: MAX_CARRIED + 1 }, (_, i) => group(`g${i}`));
    expect(carriedRecords({ rows: [{ _entity: { kind: 'user', id: 'me' }, _links: { a: many } }] })).toBe(null);
  });

  it('carries a set exactly at the cap', () => {
    const many = Array.from({ length: MAX_CARRIED }, (_, i) => group(`g${i}`));
    expect(carriedRecords({ rows: [{ _entity: { kind: 'user', id: 'me' }, _links: { a: many } }] })
      .records).toHaveLength(MAX_CARRIED);
  });

  it('ignores rows the query returned no identity for', () => {
    expect(carriedRecords({ rows: [{ displayName: 'a' }, { displayName: 'b' }] })).toBe(null);
  });
});

describe('what the model is told about it', () => {
  const carried = { kind: 'resource', records: [group('g1'), group('g2')] };

  it('says how many there are, and the exact token to write', () => {
    const block = previousContextBlock(carried);
    expect(block).toContain('2');
    expect(block).toContain(PREVIOUS_SENTINEL);
    expect(block).toContain('"op":"in"');
  });

  it('says when NOT to use it, which is the failure that actually costs', () => {
    // A question that stands on its own must not be narrowed to the last
    // answer's 27 groups — that produces a wrong answer nobody can spot.
    expect(previousContextBlock(carried)).toMatch(/only if|stands on its own|do not use/i);
  });

  it('names the entity the records belong to, so the model picks the right one', () => {
    expect(previousContextBlock(carried)).toContain('resource');
    expect(previousContextBlock({ kind: 'user', records: [{ id: 'u1' }] })).toContain('account');
  });

  it('says nothing at all when there is nothing to refer back to', () => {
    // An empty string, not a sentence about having no previous answer: a line
    // explaining an absent set is prompt the model has to read past.
    expect(previousContextBlock(null)).toBe('');
    expect(previousContextBlock({ kind: 'resource', records: [] })).toBe('');
  });
});

describe('putting the records into the definition', () => {
  const carried = { kind: 'resource', records: [group('g1'), group('g2')] };

  it('replaces the sentinel with the ids, wherever it sits', () => {
    const spec = {
      entity: 'resource',
      conditions: [
        { type: 'field', field: 'id', op: 'in', value: PREVIOUS_SENTINEL },
        { type: 'group', conditions: [{ type: 'field', field: 'id', op: 'in', value: PREVIOUS_SENTINEL }] },
      ],
    };
    const out = substitutePrevious(spec, carried);
    expect(out.conditions[0].value).toEqual(['g1', 'g2']);
    expect(out.conditions[1].conditions[0].value).toEqual(['g1', 'g2']);
  });

  it('leaves the model\'s own definition untouched', () => {
    // It is what gets logged, so it must still read as what the model said.
    const spec = { entity: 'resource', conditions: [{ type: 'field', field: 'id', op: 'in', value: PREVIOUS_SENTINEL }] };
    substitutePrevious(spec, carried);
    expect(spec.conditions[0].value).toBe(PREVIOUS_SENTINEL);
  });

  it('changes nothing when the question did not refer back', () => {
    const spec = { entity: 'resource', conditions: [{ type: 'field', field: 'displayName', op: 'eq', value: 'Finance' }] };
    expect(substitutePrevious(spec, carried)).toEqual(spec);
    expect(usedPrevious(spec, substitutePrevious(spec, carried))).toBe(false);
  });

  it('leaves a surviving sentinel alone when there is nothing to put there', () => {
    // Deliberately NOT substituted with an empty list, which would compile to a
    // condition matching nothing and read as a truthful "no results". spec.js
    // rejects the survivor instead, and the caller is told.
    const spec = { entity: 'resource', conditions: [{ type: 'field', field: 'id', op: 'in', value: PREVIOUS_SENTINEL }] };
    expect(substitutePrevious(spec, null).conditions[0].value).toBe(PREVIOUS_SENTINEL);
    expect(substitutePrevious(spec, { kind: 'resource', records: [] }).conditions[0].value).toBe(PREVIOUS_SENTINEL);
  });

  it('reports whether the earlier answer was actually picked up', () => {
    const referring = { entity: 'resource', conditions: [{ type: 'field', field: 'id', op: 'in', value: PREVIOUS_SENTINEL }] };
    expect(usedPrevious(referring, substitutePrevious(referring, carried))).toBe(true);
  });
});

describe('spotting a question that points back', () => {
  // A demonstrative on its own is not a back-reference. The noun beside it is
  // what makes it one, and requiring the noun is what keeps "deze maand" from
  // narrowing a report to last answer's groups.

  it.each([
    'Welke van deze groepen zitten in access packages?',
    'welke van deze 29 groepen hebben geen eigenaar',
    'which of these groups are in an access package?',
    'zijn die groepen recent gewijzigd?',
    'show me the owners of those applications',
  ])('reads %s as pointing back', (q) => {
    expect(refersToPrevious(q, 'resource')).toBe(true);
  });

  it.each([
    'Welke groepen zijn deze maand aangemaakt?',
    'welke groepen hebben geen eigenaar',
    'wie zit er in de groep Finance',
    'which groups have no owner?',
  ])('does NOT read %s as pointing back', (q) => {
    expect(refersToPrevious(q, 'resource')).toBe(false);
  });

  it('accepts a phrase that can mean nothing else, without a noun', () => {
    expect(refersToPrevious('en de eigenaren daarvan?', 'resource')).toBe(true);
    expect(refersToPrevious('which of those are in an access package', 'resource')).toBe(true);
  });

  it('misses a bare pronoun, on purpose', () => {
    // "en zijn die onderdeel van een access package?" — no noun after "die",
    // so this is not treated as a reference. A miss costs a rephrase; a false
    // positive costs a confident wrong answer nobody can see. Change this
    // deliberately, not by accident.
    expect(refersToPrevious('en zijn die onderdeel van een access package?', 'resource')).toBe(false);
  });

  it('wants a noun that matches the KIND that was carried', () => {
    // The last answer listed groups; a question about accounts is a new one.
    expect(refersToPrevious('welke van deze groepen', 'user')).toBe(false);
    expect(refersToPrevious('welke van deze accounts', 'user')).toBe(true);
  });

  it('survives punctuation, capitals and an empty question', () => {
    expect(refersToPrevious('WELKE VAN DEZE GROEPEN?!', 'resource')).toBe(true);
    expect(refersToPrevious('', 'resource')).toBe(false);
    expect(refersToPrevious(null, 'resource')).toBe(false);
    expect(refersToPrevious('deze groepen', 'nonsense')).toBe(false);
  });
});

describe('narrowing a definition to the previous answer', () => {
  const carried = { kind: 'resource', records: [group('g1'), group('g2')] };
  const QUESTION = 'Welke van deze groepen zitten in access packages?';

  // The definition the model actually produced for that question, from
  // BotConversations on the test deployment. It gets the hard part right — the
  // businessRoles relation IS "sits in an access package" — and leaves out the
  // narrowing, which is the whole reason this function exists.
  const MODEL_SPEC = {
    entity: 'group',
    match: 'all',
    columns: ['displayName', 'id'],
    conditions: [{ type: 'relation', relation: 'businessRoles', quantifier: 'some', match: 'all', conditions: [] }],
  };

  it('adds the ids the model left out, keeping what it did write', () => {
    const out = narrowToPrevious(MODEL_SPEC, carried, QUESTION);
    expect(out.conditions).toHaveLength(2);
    expect(out.conditions[0]).toEqual(MODEL_SPEC.conditions[0]);
    expect(out.conditions[1]).toEqual({ type: 'field', field: 'id', op: 'in', value: ['g1', 'g2'] });
  });

  it('matches the carried kind against the ENTITY, not its name', () => {
    // The model answers about groups with entity "group", whose records are
    // resource detail pages — the same kind the carried set has: the ids go on
    // the group itself. An ACCOUNT report about "these groups" reaches them
    // through memberOf (the account entity says so, narrowVia).
    expect(narrowToPrevious(MODEL_SPEC, carried, QUESTION).conditions).toHaveLength(2);
    const accounts = narrowToPrevious({ ...MODEL_SPEC, entity: 'account' }, carried, QUESTION);
    expect(accounts.conditions.at(-1)).toEqual({ type: 'relation', relation: 'memberOf', quantifier: 'some', match: 'all',
      conditions: [{ type: 'field', field: 'id', op: 'in', value: ['g1', 'g2'] }] });
  });

  it('leaves a question that points at nothing alone', () => {
    expect(narrowToPrevious(MODEL_SPEC, carried, 'welke groepen hebben geen eigenaar')).toEqual(MODEL_SPEC);
  });

  it('leaves everything alone when nothing was carried', () => {
    expect(narrowToPrevious(MODEL_SPEC, null, QUESTION)).toEqual(MODEL_SPEC);
    expect(narrowToPrevious(MODEL_SPEC, { kind: 'resource', records: [] }, QUESTION)).toEqual(MODEL_SPEC);
  });

  it('does not narrow twice when the model wrote the sentinel itself', () => {
    const already = {
      ...MODEL_SPEC,
      conditions: [{ type: 'field', field: 'id', op: 'in', value: ['g1', 'g2'] }],
    };
    expect(narrowToPrevious(already, carried, QUESTION)).toEqual(already);
  });

  it('groups an OR before adding the ids, so it narrows instead of widening', () => {
    // The dangerous case. Appending to a top-level "any" would make the ids
    // one more ALTERNATIVE — the report would return every record in the
    // previous answer PLUS everything the model asked for.
    const either = {
      entity: 'group', match: 'any', columns: ['displayName'],
      conditions: [
        { type: 'field', field: 'displayName', op: 'contains', value: 'A' },
        { type: 'field', field: 'displayName', op: 'contains', value: 'B' },
      ],
    };
    const out = narrowToPrevious(either, carried, QUESTION);

    expect(out.match).toBe('all');
    expect(out.conditions).toHaveLength(2);
    expect(out.conditions[0]).toEqual({ type: 'group', match: 'any', conditions: either.conditions });
    expect(out.conditions[1].op).toBe('in');
  });

  it('groups rather than overrunning the condition budget', () => {
    const full = {
      entity: 'group', match: 'all', columns: ['displayName'],
      conditions: Array.from({ length: MAX_CONDITIONS },
        () => ({ type: 'field', field: 'displayName', op: 'contains', value: 'x' })),
    };
    const out = narrowToPrevious(full, carried, QUESTION);
    expect(out.conditions).toHaveLength(2);
    expect(out.conditions[0].type).toBe('group');
  });
});

describe('narrowing a report that is not about the carried kind', () => {
  // "Zijn er recent leden aan deze groepen toegevoegd?" is about CHANGES, and
  // a change is not a group. Putting the group ids on the report's own id
  // field would match nothing; leaving them off reports on every change in the
  // directory. They belong on the relation that reaches a group.
  const carried = { kind: 'resource', records: [group('g1'), group('g2')] };
  const CHANGES = {
    entity: 'change', match: 'all',
    conditions: [{ type: 'field', field: 'changedAt', op: 'withinLastDays', value: 30 }],
    columns: ['changedAt', 'action'],
  };

  it('puts the ids on the relation that reaches the carried records', () => {
    const out = narrowToPrevious(CHANGES, carried, 'zijn er recent leden aan deze groepen toegevoegd?');
    expect(out.conditions).toHaveLength(2);
    expect(out.conditions[1]).toEqual({
      type: 'relation', relation: 'resource', quantifier: 'some', match: 'all',
      conditions: [{ type: 'field', field: 'id', op: 'in', value: ['g1', 'g2'] }],
    });
  });

  it('keeps what the model asked for', () => {
    const out = narrowToPrevious(CHANGES, carried, 'zijn er recent leden aan deze groepen toegevoegd?');
    expect(out.conditions[0]).toEqual(CHANGES.conditions[0]);
  });

  it('narrows to the accounts when accounts were carried', () => {
    // Same entity, different carried kind: the account relation this time.
    const out = narrowToPrevious(CHANGES, { kind: 'user', records: [{ id: 'u1' }] },
      'zijn er wijzigingen voor deze accounts?');
    expect(out.conditions[1].relation).toBe('account');
  });

  it('does not narrow twice when it is already limited through a relation', () => {
    const already = narrowToPrevious(CHANGES, carried, 'zijn er recent leden aan deze groepen toegevoegd?');
    expect(narrowToPrevious(already, carried, 'zijn er recent leden aan deze groepen toegevoegd?')).toEqual(already);
  });

  it('leaves a report alone when nothing on it can reach the carried kind', () => {
    const identities = { entity: 'identity', match: 'all', conditions: [], columns: ['displayName'] };
    expect(narrowToPrevious(identities, carried, 'welke van deze groepen')).toEqual(identities);
  });
});

describe('narrowToPrevious — the carried ids written on the wrong relation', () => {
  const carried = { kind: 'resource', records: [{ id: 'g1', name: 'A' }, { id: 'g2', name: 'B' }] };
  const inRole = { type: 'relation', relation: 'businessRoles', quantifier: 'some', match: 'all', conditions: [] };

  it('moves the group ids from the members relation to the group itself', () => {
    // Verbatim shape: "welke van deze groepen zijn onderdeel van een access package?"
    const written = { entity: 'group', match: 'all', conditions: [
      { type: 'relation', relation: 'members', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'id', op: 'in', value: ['g1', 'g2'] }] },
      inRole,
    ] };
    const out = narrowToPrevious(written, carried, 'welke van deze groepen zijn onderdeel van een access package?');
    expect(out.conditions).toEqual([inRole, { type: 'field', field: 'id', op: 'in', value: ['g1', 'g2'] }]);
  });

  it('keeps other conditions of that relation, and leaves a list that is not the carried one alone', () => {
    const mixed = { entity: 'group', match: 'all', conditions: [
      { type: 'relation', relation: 'members', quantifier: 'some', match: 'all', conditions: [
        { type: 'field', field: 'accountEnabled', op: 'eq', value: true },
        { type: 'field', field: 'id', op: 'in', value: ['g1', 'g2'] },
      ] },
    ] };
    const out = narrowToPrevious(mixed, carried, 'deze groepen');
    expect(out.conditions[0].conditions).toEqual([{ type: 'field', field: 'accountEnabled', op: 'eq', value: true }]);
    expect(out.conditions[1]).toEqual({ type: 'field', field: 'id', op: 'in', value: ['g1', 'g2'] });

    const other = { entity: 'group', match: 'all', conditions: [
      { type: 'relation', relation: 'members', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'id', op: 'in', value: ['u9'] }] },
    ] };
    expect(narrowToPrevious(other, carried, 'welke groepen zijn openbaar').conditions[0].conditions[0].value).toEqual(['u9']);
  });

  it('leaves the ids where they are when that relation IS of the carried kind', () => {
    // Changes on these groups: the group ids belong on change.resource.
    const changes = { entity: 'change', match: 'all', conditions: [
      { type: 'relation', relation: 'resource', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'id', op: 'in', value: ['g1', 'g2'] }] },
    ] };
    expect(narrowToPrevious(changes, carried, 'updates aan deze groepen').conditions).toEqual(changes.conditions);
  });
});

describe('narrowToPrevious — carried group ids on a user report\'s own id', () => {
  it('moves them onto memberOf, where a user reaches groups', () => {
    // Verbatim: the follow-up written as user where id in [group ids].
    const carried = { kind: 'resource', records: [{ id: 'g1', name: 'A' }, { id: 'g2', name: 'B' }] };
    const written = { entity: 'user', match: 'all', conditions: [
      { type: 'field', field: 'id', op: 'in', value: ['g1', 'g2'] },
      { type: 'relation', relation: 'businessRoles', quantifier: 'some', match: 'all', conditions: [] },
    ] };
    const out = narrowToPrevious(written, carried, 'which of these groups are in an access package?');
    expect(out.conditions[0]).toMatchObject({ relation: 'businessRoles' });
    expect(out.conditions[1]).toEqual({ type: 'relation', relation: 'memberOf', quantifier: 'some', match: 'all',
      conditions: [{ type: 'field', field: 'id', op: 'in', value: ['g1', 'g2'] }] });
  });
});

describe('narrowToPrevious — carried group ids on the wrong relation of a change report', () => {
  it('moves them from change.account onto change.resource, keeping the rest', () => {
    // Verbatim: "Have there been any changes to these groups in the last 180 days?"
    const carried = { kind: 'resource', records: [{ id: 'g1', name: 'A' }, { id: 'g2', name: 'B' }] };
    const isGroup = { type: 'field', field: 'resourceType', op: 'eq', value: 'Group' };
    const window = { type: 'field', field: 'changedAt', op: 'withinLastDays', value: 180 };
    const written = { entity: 'change', match: 'all', conditions: [
      { type: 'relation', relation: 'resource', quantifier: 'some', match: 'all', conditions: [isGroup] },
      { type: 'relation', relation: 'account', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'id', op: 'in', value: ['g1', 'g2'] }] },
      window,
    ] };
    const out = narrowToPrevious(written, carried, 'changes to these groups in the last 180 days?');
    expect(out.conditions).toEqual([
      { type: 'relation', relation: 'resource', quantifier: 'some', match: 'all', conditions: [isGroup] },
      window,
      { type: 'relation', relation: 'resource', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'id', op: 'in', value: ['g1', 'g2'] }] },
    ]);
  });
});

describe('carriedRecords — the definition rides along', () => {
  it('keeps the spec that produced the records beside them, and nothing when there are no records', () => {
    const spec = { entity: 'group', match: 'all', conditions: [], columns: ['displayName'] };
    const out = carriedRecords({ spec, rows: [{ _entity: { kind: 'resource', id: 'g1' } }, { _entity: { kind: 'resource', id: 'g2' } }] });
    expect(out.spec).toBe(spec);
    expect(out.records).toHaveLength(2);
    expect(carriedRecords({ spec, rows: [] })).toBeNull();
    // A change answer: rows with no page to refer back to still carry the definition.
    const changes = carriedRecords({ spec, rows: [{ _entity: { kind: null, id: 'c1' } }, { _entity: { kind: null, id: 'c2' } }] });
    expect(changes).toEqual({ kind: null, records: [], spec });
  });
});

describe('narrowToPrevious — "these" inside an any-group', () => {
  it('takes the id list out of the alternatives, so the other alternative is required again', () => {
    // Verbatim: "Welke van deze groepen zijn onderdeel van een access package?"
    // as resourceType Group AND (businessRoles some OR id in these) AND id in these.
    const carried = { kind: 'resource', records: [{ id: 'g1', name: 'A' }, { id: 'g2', name: 'B' }] };
    const inRole = { type: 'relation', relation: 'businessRoles', quantifier: 'some', match: 'all', conditions: [] };
    const these = { type: 'field', field: 'id', op: 'in', value: ['g1', 'g2'] };
    const isGroup = { type: 'field', field: 'resourceType', op: 'eq', value: 'Group' };
    const out = narrowToPrevious({ entity: 'resource', match: 'all', conditions: [isGroup, { type: 'group', match: 'any', conditions: [inRole, these] }, these] },
      carried, 'welke van deze groepen zijn onderdeel van een access package?');
    expect(out.conditions).toEqual([isGroup, inRole, these]);
  });
});

describe('carryForward — what the chat carries after an answer', () => {
  const groups = { kind: 'resource', records: [{ id: 'g1', name: 'A' }], spec: { entity: 'group' } };
  const changes = { kind: null, records: [], spec: { entity: 'change' } };

  it('keeps the earlier records when the new answer carries none, and takes the new definition', () => {
    expect(carryForward(groups, changes)).toEqual({ kind: 'resource', records: groups.records, spec: { entity: 'change' } });
  });

  it('replaces the set when the new answer has records of its own, and starts from nothing', () => {
    const users = { kind: 'user', records: [{ id: 'u1', name: 'B' }], spec: { entity: 'user' } };
    expect(carryForward(groups, users)).toBe(users);
    expect(carryForward(null, changes)).toBe(changes);
    expect(carryForward(groups, null)).toBe(groups);
  });
});
