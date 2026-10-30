// Unit tests for the context create/update helpers (#1032). validateCreate
// and the no-parent-change field collection are pure; the parent-validation
// branches (which hit the DB + cycle guard) are covered end-to-end by
// contexts.coverage.test.js + contexts.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js'); // manual mock — don't open a real pool on import
import { queryOne } from '../../db/connection.js';
import { validateCreateContextBody, validateContextCategory, resolveCreateCategory, buildContextUpdate } from './crudHelpers.js';

const PARENT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('resolveCreateCategory', () => {
  beforeEach(() => queryOne.mockReset());

  it('without a parent: the given template, else null — no lookup', async () => {
    expect(await resolveCreateCategory({ contextCategory: 'Segment' })).toEqual({ contextCategory: 'Segment' });
    expect(await resolveCreateCategory({})).toEqual({ contextCategory: null });
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('with a parent: the parent lends its template unless the body names one', async () => {
    queryOne.mockResolvedValue({ targetType: 'Principal', contextCategory: 'OrganizationalUnit' });
    const base = { targetType: 'Principal', parentContextId: PARENT };
    expect(await resolveCreateCategory(base)).toEqual({ contextCategory: 'OrganizationalUnit' });
    expect(await resolveCreateCategory({ ...base, contextCategory: 'Segment' })).toEqual({ contextCategory: 'Segment' });
    expect(queryOne.mock.calls[0][1]).toEqual([PARENT]);
  });

  it('a parent without a template yields null, not undefined', async () => {
    queryOne.mockResolvedValueOnce({ targetType: 'Principal', contextCategory: null });
    expect(await resolveCreateCategory({ targetType: 'Principal', parentContextId: PARENT })).toEqual({ contextCategory: null });
  });

  it('hands the parent validation error through', async () => {
    expect(await resolveCreateCategory({ targetType: 'Principal', parentContextId: 'nope' }))
      .toEqual({ error: { status: 400, message: 'Invalid parentContextId' } });
    queryOne.mockResolvedValueOnce({ targetType: 'Resource', contextCategory: null });
    expect(await resolveCreateCategory({ targetType: 'Principal', parentContextId: PARENT }))
      .toEqual({ error: { status: 400, message: 'Parent context has a different targetType' } });
  });
});

describe('validateContextCategory', () => {
  it.each(['OrganizationalUnit', 'LogicalApplication', 'Tag', 'Segment', null, undefined])('accepts %s', (v) => {
    expect(validateContextCategory(v)).toBeNull();
  });
  it.each(['Department', '', 'organizationalunit', 0])('rejects %s', (v) => {
    expect(validateContextCategory(v)).toMatchObject({ status: 400, message: /must be one of/ });
  });
});

describe('validateCreateContextBody', () => {
  it('accepts a complete body', () => {
    expect(validateCreateContextBody({ targetType: 'Principal', contextType: 'Department', displayName: 'Eng' })).toBeNull();
  });
  it('accepts a template and rejects a non-template contextCategory', () => {
    const base = { targetType: 'Principal', contextType: 'Department', displayName: 'Eng' };
    expect(validateCreateContextBody({ ...base, contextCategory: 'OrganizationalUnit' })).toBeNull();
    expect(validateCreateContextBody({ ...base, contextCategory: 'Department' })).toMatchObject({ status: 400 });
  });
  it('rejects an unknown targetType', () => {
    expect(validateCreateContextBody({ targetType: 'Nope', contextType: 'x', displayName: 'y' }))
      .toMatchObject({ status: 400, message: 'targetType is required' });
  });
  it('rejects a missing contextType', () => {
    expect(validateCreateContextBody({ targetType: 'Principal', displayName: 'y' }))
      .toMatchObject({ message: 'contextType is required' });
  });
  it('rejects a missing displayName', () => {
    expect(validateCreateContextBody({ targetType: 'Principal', contextType: 'x' }))
      .toMatchObject({ message: 'displayName is required' });
  });
});

describe('buildContextUpdate (no parent change → no DB)', () => {
  const ctx = { targetType: 'Identity', displayName: 'Old', parentContextId: null };

  it('collects updatable fields into sets/params', async () => {
    const out = await buildContextUpdate('id1', { displayName: 'New', description: null, ownerUserId: 'u1' }, ctx, false);
    expect(out.error).toBeUndefined();
    expect(out.sets).toEqual(['"displayName" = $1', '"description" = $2', '"ownerUserId" = $3']);
    expect(out.params).toEqual(['New', null, 'u1']);
    expect(out.parentChanged).toBe(false);
  });

  it('flags userRenamed for a generated context whose name diverges', async () => {
    const out = await buildContextUpdate('id1', { displayName: 'Renamed' }, ctx, true);
    expect(out.sets).toEqual(['"displayName" = $1', '"userRenamed" = $2']);
    expect(out.params).toEqual(['Renamed', true]);
  });

  it('does not flag userRenamed when a generated name is unchanged', async () => {
    const out = await buildContextUpdate('id1', { displayName: 'Old' }, ctx, true);
    expect(out.sets).toEqual(['"displayName" = $1']);
  });

  it('sets contextCategory to a template or to null, and refuses anything else', async () => {
    expect(await buildContextUpdate('id1', { contextCategory: 'Segment' }, ctx, false))
      .toMatchObject({ sets: ['"contextCategory" = $1'], params: ['Segment'] });
    expect(await buildContextUpdate('id1', { contextCategory: null }, ctx, false))
      .toMatchObject({ sets: ['"contextCategory" = $1'], params: [null] });
    expect(await buildContextUpdate('id1', { displayName: 'X', contextCategory: 'Team' }, ctx, false))
      .toEqual({ error: { status: 400, message: expect.stringMatching(/contextCategory must be one of/) } });
  });

  it('accepts extendedAttributes and yields empty sets when nothing is updatable', async () => {
    expect((await buildContextUpdate('id1', { extendedAttributes: { a: 1 } }, ctx, false)).sets)
      .toEqual(['"extendedAttributes" = $1']);
    expect((await buildContextUpdate('id1', { foo: 'bar' }, ctx, false)).sets).toEqual([]);
  });
});
