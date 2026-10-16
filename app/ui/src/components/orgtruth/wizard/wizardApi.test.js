// The wizard's API helpers: the error idiom, the 501 → "not available yet"
// mapping, and the response-shape tolerance.
import { describe, it, expect, vi } from 'vitest';
import {
  API, NOT_AVAILABLE, NotAvailableError, asList, getJson, isoDate, readOrThrow, sendForm, sendJson, sourceFromUpload,
} from './wizardApi';

const res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

describe('readOrThrow', () => {
  it('returns the body of a good response', async () => {
    await expect(readOrThrow(res({ a: 1 }))).resolves.toEqual({ a: 1 });
  });

  it('turns a 501 into NotAvailableError with the notice', async () => {
    const err = await readOrThrow(res({ error: 'Not implemented' }, 501)).catch(e => e);
    expect(err).toBeInstanceOf(NotAvailableError);
    expect(err.notAvailable).toBe(true);
    expect(err.message).toBe(NOT_AVAILABLE);
  });

  it('uses the API sentence, appends the validator sentences, else the status', async () => {
    await expect(readOrThrow(res({ error: 'Name exists' }, 409))).rejects.toThrow(/^Name exists$/);
    await expect(readOrThrow(res({ error: 'Invalid recipe', errors: ['A.', 'B.'] }, 400))).rejects.toThrow(/^Invalid recipe A\. B\.$/);
    await expect(readOrThrow(res({ errors: [] }, 400))).rejects.toThrow(/^HTTP 400$/);
    const broken = { ok: false, status: 500, json: async () => { throw new Error('no json'); } };
    await expect(readOrThrow(broken)).rejects.toThrow(/^HTTP 500$/);
  });
});

describe('request helpers', () => {
  it('getJson prefixes the API path', async () => {
    const authFetch = vi.fn(async () => res([1]));
    await expect(getJson(authFetch, '/profiles')).resolves.toEqual([1]);
    expect(authFetch).toHaveBeenCalledWith(`${API}/profiles`);
  });

  it('sendJson posts JSON by default and honours the method', async () => {
    const authFetch = vi.fn(async () => res({ id: 1 }));
    await sendJson(authFetch, '/profiles', { name: 'P' });
    expect(authFetch).toHaveBeenLastCalledWith('/api/org-truth/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"P"}' });
    await sendJson(authFetch, '/profiles/1', {}, 'PUT');
    expect(authFetch.mock.calls[1][1].method).toBe('PUT');
  });

  it('sendForm posts the FormData without a Content-Type header', async () => {
    const authFetch = vi.fn(async () => res({ id: 's' }));
    const fd = new FormData();
    await sendForm(authFetch, '/sources', fd);
    expect(authFetch).toHaveBeenCalledWith('/api/org-truth/sources', { method: 'POST', body: fd });
  });
});

describe('shape helpers', () => {
  it('asList accepts an array or a keyed object', () => {
    expect(asList([1, 2], 'x')).toEqual([1, 2]);
    expect(asList({ x: [3] }, 'x')).toEqual([3]);
    expect(asList({ x: 'nope' }, 'x')).toEqual([]);
    expect(asList(null, 'x')).toEqual([]);
  });

  it('sourceFromUpload keeps the fields the wizard shows, with defaults', () => {
    expect(sourceFromUpload({ id: 's1', fileName: 'P.csv', rowCount: 4, columns: [{ name: 'A' }], observedAt: '2026-10-01', content: 'x' }))
      .toEqual({ id: 's1', displayName: 'P.csv', fileName: 'P.csv', observedAt: '2026-10-01', rowCount: 4, columns: [{ name: 'A' }] });
    expect(sourceFromUpload({ id: 's2', displayName: 'Projects' }))
      .toEqual({ id: 's2', displayName: 'Projects', fileName: '', observedAt: null, rowCount: null, columns: [] });
    expect(sourceFromUpload({ id: 's3' }).displayName).toBe('');
  });

  it('isoDate formats a timestamp as yyyy-mm-dd and blanks a bad one', () => {
    expect(isoDate(Date.UTC(2026, 8, 30, 12))).toBe('2026-09-30');
    expect(isoDate(Number.NaN)).toBe('');
  });
});
