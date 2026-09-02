// The client-side attribute-label cache (issue #872).
//
// It holds no rule of its own — the point of these cases is that it faithfully
// serves what the server said, accepts both spellings of a key, and degrades to
// "no answer" (so each call site keeps its own fallback) rather than inventing
// one when the endpoint is unreachable.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  attributeLabel,
  setAttributeLabels,
  loadAttributeLabels,
  resetAttributeLabels,
} from './attributeLabels';

const KEY = 'extension_8ce8d3db3b314def88d829e15494e83f_sAMAccountName';

beforeEach(() => resetAttributeLabels());

describe('attributeLabel', () => {
  it('returns the server label for the raw storage key', () => {
    setAttributeLabels({ [KEY]: 'sAMAccountName' });
    expect(attributeLabel(KEY)).toBe('sAMAccountName');
  });

  it('accepts the ext.-namespaced filter/sort spelling of the same key', () => {
    setAttributeLabels({ [KEY]: 'sAMAccountName' });
    expect(attributeLabel(`ext.${KEY}`)).toBe('sAMAccountName');
  });

  it('returns null for a key the server did not relabel, so the caller keeps its own fallback', () => {
    setAttributeLabels({ [KEY]: 'sAMAccountName' });
    expect(attributeLabel('userType')).toBeNull();
    expect(attributeLabel('ext.userType')).toBeNull();
    expect(attributeLabel('department')).toBeNull();
  });

  it('returns null for null/undefined instead of throwing mid-render', () => {
    // The map deliberately holds entries named "null" and "undefined": those are
    // legal JSON keys, so a guard that stringified the argument instead of
    // rejecting it would answer `attributeLabel(null)` with someone else's label.
    setAttributeLabels({ null: 'NotThis', undefined: 'NorThis' });
    expect(attributeLabel(null)).toBeNull();
    expect(attributeLabel(undefined)).toBeNull();
  });

  it('returns null before anything has loaded', () => {
    expect(attributeLabel(KEY)).toBeNull();
  });

  it('strips the ext. namespace only from the front of a key', () => {
    // `ext.` is a prefix the matrix adds, not a substring to hunt for. A stored
    // attribute whose own name contains it must still resolve as itself —
    // an unanchored strip would look up `sfTeamID` and answer null.
    setAttributeLabels({ 'sfext.TeamID': 'sfext.TeamID' });
    expect(attributeLabel('sfext.TeamID')).toBe('sfext.TeamID');
  });

  it('ignores a non-object payload rather than reading properties off it', () => {
    // A string is the realistic bad payload — a proxy or error page answering the
    // endpoint with text. Object.assign would spread it into index-keyed entries,
    // so "0" reading back as "n" is the observable form of that bug.
    setAttributeLabels('nope');
    expect(attributeLabel(KEY)).toBeNull();
    expect(attributeLabel('0')).toBeNull();
    expect(attributeLabel('length')).toBeNull();
  });

  it('does not resolve inherited Object.prototype keys as labels', () => {
    setAttributeLabels({});
    expect(attributeLabel('constructor')).toBeNull();
    expect(attributeLabel('toString')).toBeNull();
  });
});

describe('loadAttributeLabels', () => {
  const ok = (labels) => vi.fn(async () => ({ ok: true, json: async () => ({ labels }) }));

  it('fetches once and serves every later caller from cache', async () => {
    const authFetch = ok({ [KEY]: 'sAMAccountName' });

    await loadAttributeLabels(authFetch);
    await loadAttributeLabels(authFetch);

    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(authFetch).toHaveBeenCalledWith('/api/attribute-labels');
    expect(attributeLabel(KEY)).toBe('sAMAccountName');
  });

  it('de-duplicates concurrent callers into one request', async () => {
    const authFetch = ok({ [KEY]: 'sAMAccountName' });

    await Promise.all([loadAttributeLabels(authFetch), loadAttributeLabels(authFetch)]);

    expect(authFetch).toHaveBeenCalledTimes(1);
  });

  it('leaves the cache empty on a non-ok response (AC11)', async () => {
    const authFetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));

    await loadAttributeLabels(authFetch);

    expect(attributeLabel(KEY)).toBeNull();
  });

  it('leaves the cache empty when the request rejects outright', async () => {
    const authFetch = vi.fn(async () => { throw new Error('offline'); });

    await expect(loadAttributeLabels(authFetch)).resolves.toEqual({});
    expect(attributeLabel(KEY)).toBeNull();
  });

  it('survives a response body with no labels field', async () => {
    const authFetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));

    await loadAttributeLabels(authFetch);

    expect(attributeLabel(KEY)).toBeNull();
  });

  it('fetches on a freshly loaded module, without a reset priming it first', async () => {
    // Every other case here runs after `resetAttributeLabels()`, which would hide a
    // module that started life believing it had already loaded — the app never calls
    // reset, so a wrong initial state means the map is never fetched at all and every
    // surface keeps the raw key for the whole session.
    vi.resetModules();
    const fresh = await import('./attributeLabels');
    const authFetch = ok({ [KEY]: 'sAMAccountName' });

    await fresh.loadAttributeLabels(authFetch);

    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(fresh.attributeLabel(KEY)).toBe('sAMAccountName');
  });

  it('does not re-fetch after a failure that already resolved the load', async () => {
    // A failed load still counts as "answered" — otherwise every render of every
    // labelled surface would retry a dead endpoint.
    const authFetch = vi.fn(async () => { throw new Error('offline'); });

    await loadAttributeLabels(authFetch);
    await loadAttributeLabels(authFetch);

    expect(authFetch).toHaveBeenCalledTimes(1);
  });
});
