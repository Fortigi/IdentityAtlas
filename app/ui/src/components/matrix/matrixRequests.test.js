import { describe, it, expect, vi } from 'vitest';
import { sendJson, isNameClash } from './matrixRequests';

const response = (body, { ok = true, status = 200, badJson = false } = {}) => ({
  ok, status, json: badJson ? async () => { throw new Error('not json'); } : async () => body,
});

describe('sendJson', () => {
  it('POSTs the body as JSON by default and returns the parsed answer', async () => {
    const authFetch = vi.fn(async () => response({ id: 'sf-1' }));
    await expect(sendJson(authFetch, '/api/x', { body: { a: 1 } })).resolves.toEqual({ id: 'sf-1' });
    expect(authFetch).toHaveBeenCalledWith('/api/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
  });

  it('uses the method it is given', async () => {
    const authFetch = vi.fn(async () => response({}));
    await sendJson(authFetch, '/api/x/1', { method: 'PUT', body: {} });
    expect(authFetch.mock.calls[0][1].method).toBe('PUT');
  });

  it("throws the API's own message with the status on a refusal", async () => {
    const authFetch = async () => response({ error: 'A filter named "S" already exists' }, { ok: false, status: 409 });
    const err = await sendJson(authFetch, '/api/x', { body: {}, fallback: 'Could not save' }).catch(e => e);
    expect(err.message).toBe('A filter named "S" already exists');
    expect(err.status).toBe(409);
    expect(isNameClash(err)).toBe(true);
  });

  it('falls back to its own message and the status when the refusal has none', async () => {
    const authFetch = async () => response(null, { ok: false, status: 500, badJson: true });
    const err = await sendJson(authFetch, '/api/x', { body: {}, fallback: 'Could not save' }).catch(e => e);
    expect(err.message).toBe('Could not save (HTTP 500)');
    expect(isNameClash(err)).toBe(false);
  });

  it('has a generic fallback and tolerates an unparseable success body', async () => {
    await expect(sendJson(async () => response(null, { badJson: true }), '/api/x')).resolves.toEqual({});
    const err = await sendJson(async () => response({}, { ok: false, status: 404 }), '/api/x').catch(e => e);
    expect(err.message).toBe('Request failed (HTTP 404)');
  });
});

describe('isNameClash', () => {
  it('is only a 409', () => {
    expect(isNameClash({ status: 409 })).toBe(true);
    expect(isNameClash({ status: 400 })).toBe(false);
    expect(isNameClash(null)).toBe(false);
  });
});
