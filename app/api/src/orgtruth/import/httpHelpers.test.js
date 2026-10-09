import { describe, it, expect, vi } from 'vitest';
import { actorOf, isUuid, handle, sendInvalid } from './httpHelpers.js';

const fakeRes = () => {
  const res = { headersSent: false };
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
};

describe('actorOf', () => {
  it('prefers the user name, then the object id, then anonymous', () => {
    expect(actorOf({ user: { preferred_username: 'ann@contoso.com', oid: 'o-1' } })).toBe('ann@contoso.com');
    expect(actorOf({ user: { oid: 'o-1' } })).toBe('o-1');
    expect(actorOf({ user: {} })).toBe('anonymous');
    expect(actorOf({})).toBe('anonymous');
  });
});

describe('isUuid', () => {
  it('accepts only a uuid string', () => {
    expect(isUuid('6f1c1c2e-8d3b-4a8e-9c1d-2b3c4d5e6f70')).toBe(true);
    expect(isUuid('6f1c1c2e-8d3b-4a8e-9c1d-2b3c4d5e6f7')).toBe(false);
    expect(isUuid(' 6f1c1c2e-8d3b-4a8e-9c1d-2b3c4d5e6f70')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});

describe('handle', () => {
  it('runs the handler and leaves a good response alone', async () => {
    const res = fakeRes();
    await handle('list things', async (_req, r) => r.status(200).json({ ok: true }))({}, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.status).toHaveBeenCalledTimes(1);
  });

  it('answers a JSON 500 naming what failed when the handler throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = fakeRes();
    await handle('list things', async () => { throw new Error('db down'); })({}, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to list things.' });
    expect(spy).toHaveBeenCalledWith('org-truth: failed to list things:', 'db down');
    spy.mockRestore();
  });

  it('does not write a second response when the headers already went out', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = fakeRes();
    res.headersSent = true;
    await handle('stream', async () => { throw new Error('late'); })({}, res);
    expect(res.status).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('sendInvalid', () => {
  it('answers 400 with the summary and the sentences', () => {
    const res = fakeRes();
    sendInvalid(res, 'Bad.', ['One.', 'Two.']);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Bad.', errors: ['One.', 'Two.'] });
  });
});
