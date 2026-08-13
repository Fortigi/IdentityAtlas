// Unit tests for the context create/update helpers (#1032). validateCreate
// and the no-parent-change field collection are pure; the parent-validation
// branches (which hit the DB + cycle guard) are covered end-to-end by
// contexts.coverage.test.js + contexts.test.js.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js'); // manual mock — don't open a real pool on import
import { validateCreateContextBody, buildContextUpdate } from './crudHelpers.js';

describe('validateCreateContextBody', () => {
  it('accepts a complete body', () => {
    expect(validateCreateContextBody({ targetType: 'Principal', contextType: 'Department', displayName: 'Eng' })).toBeNull();
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

  it('accepts extendedAttributes and yields empty sets when nothing is updatable', async () => {
    expect((await buildContextUpdate('id1', { extendedAttributes: { a: 1 } }, ctx, false)).sets)
      .toEqual(['"extendedAttributes" = $1']);
    expect((await buildContextUpdate('id1', { foo: 'bar' }, ctx, false)).sets).toEqual([]);
  });
});
