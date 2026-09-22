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
  carriedRecords, previousContextBlock, substitutePrevious, usedPrevious, MAX_CARRIED,
} from './followUp.js';
import { PREVIOUS_SENTINEL } from '../nlreports/spec.js';

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
