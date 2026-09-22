import { describe, it, expect, vi } from 'vitest';
import { callerFromTurn, mayAsk, withTokenTimeout, REQUIRED_PERMISSION, CONNECTION_NAME, TOKEN_SERVICE_TIMEOUT_MS } from './auth.js';

const OID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const turn = () => ({
  activity: { channelId: 'msteams', from: { id: '29:abc', aadObjectId: OID }, conversation: { id: 'conv-1' } },
});

const ok = (over = {}) => ({
  getUserToken: vi.fn(async () => 'a.b.c'),
  verify: vi.fn(async () => ({ decoded: { oid: OID }, roles: ['RoleMiner'], permissions: new Set(['data.read.reports']) })),
  ...over,
});

describe('mayAsk', () => {
  it('accepts the asking permission', () => {
    expect(mayAsk(new Set([REQUIRED_PERMISSION]))).toBe(true);
  });

  it('does NOT accept report-building as a substitute for asking', () => {
    // Building feels like it should imply asking; it deliberately does not, so
    // that the deny case stays statable. See auth.js.
    expect(mayAsk(new Set(['data.write.reports']))).toBe(false);
  });

  it('accepts the wildcard', () => {
    expect(mayAsk(new Set(['*']))).toBe(true);
  });

  it('refuses a signed-in user with every OTHER permission', () => {
    // The discriminating case: not an empty set, but a full one missing
    // exactly the permission that matters.
    expect(mayAsk(new Set(['data.read', 'data.export.ui', 'data.share', 'data.write.tags', 'data.write.reports', 'admin.crawlers']))).toBe(false);
  });

  it('refuses an empty or missing permission set', () => {
    expect(mayAsk(new Set())).toBe(false);
    expect(mayAsk(null)).toBe(false);
    expect(mayAsk(undefined)).toBe(false);
  });
});

describe('withTokenTimeout', () => {
  it('returns the value when the call answers in time', async () => {
    await expect(withTokenTimeout(Promise.resolve('tok'), 'getUserToken', 1000)).resolves.toBe('tok');
  });

  it('rejects rather than hanging forever, naming the call', async () => {
    // The whole point. A token-service call that never settles produced a turn
    // that never replied and never logged — no answer, no error, no sign-in
    // card, nothing to look at. That is the one failure this bot must not have.
    vi.useFakeTimers();
    try {
      const never = withTokenTimeout(new Promise(() => {}), 'getUserToken', 50);
      const assertion = expect(never).rejects.toThrow(/getUserToken did not answer within 50ms/);
      await vi.advanceTimersByTimeAsync(51);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a real rejection unchanged', async () => {
    await expect(withTokenTimeout(Promise.reject(new Error('401 unauthorised')), 'getUserToken', 1000))
      .rejects.toThrow('401 unauthorised');
  });
});

describe('callerFromTurn', () => {
  it('asks the caller to sign in when the token service hangs, and says so in the log', async () => {
    // A hang must degrade to the same visible outcome as "not signed in yet" —
    // the caller gets a card either way — but only the hang is logged, because
    // only the hang is something an operator has to act on.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const deps = ok({ getUserToken: vi.fn(() => new Promise(() => {})) });
      const pending = callerFromTurn(turn(), deps);
      await vi.advanceTimersByTimeAsync(TOKEN_SERVICE_TIMEOUT_MS + 1);

      await expect(pending).resolves.toEqual({ ok: false, reason: 'no-token' });
      expect(err.mock.calls.join(' ')).toMatch(/did not answer within/);
    } finally {
      vi.useRealTimers();
      err.mockRestore();
    }
  });

  it('does not log when the caller simply has not signed in yet', async () => {
    // The ordinary case must stay quiet, or the log that matters gets ignored.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await callerFromTurn(turn(), ok({ getUserToken: vi.fn(async () => null) }));
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('returns the oid from the VERIFIED token', async () => {
    await expect(callerFromTurn(turn(), ok())).resolves.toEqual({ ok: true, oid: OID });
  });

  it('never trusts the activity\'s own aadObjectId', async () => {
    // The activity claims one identity, the signed token another. The token
    // wins — a bot that reads the body answers about whoever asks it to.
    const context = turn();
    context.activity.from.aadObjectId = '99999999-9999-9999-9999-999999999999';
    const deps = ok({ verify: vi.fn(async () => ({ decoded: { oid: OID }, roles: [], permissions: new Set(['*']) })) });

    await expect(callerFromTurn(context, deps)).resolves.toEqual({ ok: true, oid: OID });
  });

  it('asks the token service for the configured connection and this user', async () => {
    const deps = ok();
    await callerFromTurn(turn(), deps);
    expect(deps.getUserToken).toHaveBeenCalledWith(expect.anything(), CONNECTION_NAME);
  });

  it('reports no-token when the caller has not consented, without logging an error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = ok({ getUserToken: vi.fn(async () => null) });

    await expect(callerFromTurn(turn(), deps)).resolves.toEqual({ ok: false, reason: 'no-token' });
    expect(deps.verify).not.toHaveBeenCalled();
    // Not consenting yet is ordinary, not a fault. Logging it as an error
    // trains whoever reads the log to ignore the ones that matter.
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('reports no-token when the token service itself throws', async () => {
    const deps = ok({ getUserToken: vi.fn(async () => { throw new Error('token service unavailable'); }) });
    await expect(callerFromTurn(turn(), deps)).resolves.toEqual({ ok: false, reason: 'no-token' });
  });

  it('refuses a token that does not verify, and says so in the log', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = ok({ verify: vi.fn(async () => { throw new Error('Token issued by unexpected tenant'); }) });

    await expect(callerFromTurn(turn(), deps)).resolves.toEqual({ ok: false, reason: 'invalid-token' });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('refuses a verified token whose holder may not ask', async () => {
    const deps = ok({ verify: vi.fn(async () => ({ decoded: { oid: OID }, roles: ['Servicedesk'], permissions: new Set(['data.read']) })) });
    await expect(callerFromTurn(turn(), deps)).resolves.toEqual({ ok: false, reason: 'forbidden' });
  });

  it('refuses a verified APPLICATION token — it has no person to answer as', async () => {
    // A valid token with every permission and no oid. Checking permissions but
    // not the oid would let this through and then resolve a caller of
    // `undefined`.
    const deps = ok({ verify: vi.fn(async () => ({ decoded: { roles: ['Admin'] }, roles: ['Admin'], permissions: new Set(['*']) })) });
    await expect(callerFromTurn(turn(), deps)).resolves.toEqual({ ok: false, reason: 'invalid-token' });
  });

  it.each([['', 'empty string'], [null, 'null'], [12345, 'a number']])(
    'refuses a token whose oid is %j (%s)', async (oid) => {
      const deps = ok({ verify: vi.fn(async () => ({ decoded: { oid }, roles: [], permissions: new Set(['*']) })) });
      await expect(callerFromTurn(turn(), deps)).resolves.toEqual({ ok: false, reason: 'invalid-token' });
    },
  );

  it('asks the Bot Framework token service for this user on this channel', async () => {
    // The default token fetch, exercised through a fake UserTokenClient rather
    // than replaced — the argument ORDER of getUserToken is the thing that
    // silently returns nothing when it is wrong.
    const getUserToken = vi.fn(async () => ({ token: 'a.b.c' }));
    const context = turn();
    context.adapter = { UserTokenClientKey: 'utc' };
    context.turnState = new Map([['utc', { getUserToken }]]);

    const verify = vi.fn(async () => ({ decoded: { oid: OID }, roles: [], permissions: new Set(['*']) }));
    await expect(callerFromTurn(context, { verify })).resolves.toEqual({ ok: true, oid: OID });

    expect(getUserToken).toHaveBeenCalledWith('29:abc', CONNECTION_NAME, 'msteams', undefined);
  });

  it('treats a missing token client as "not signed in", not as a crash', async () => {
    const context = turn();
    context.adapter = { UserTokenClientKey: 'utc' };
    context.turnState = new Map();

    await expect(callerFromTurn(context, { verify: vi.fn() })).resolves.toEqual({ ok: false, reason: 'no-token' });
  });

  it('treats a token service that returns no token as "not signed in"', async () => {
    const context = turn();
    context.adapter = { UserTokenClientKey: 'utc' };
    context.turnState = new Map([['utc', { getUserToken: vi.fn(async () => null) }]]);

    await expect(callerFromTurn(context, { verify: vi.fn() })).resolves.toEqual({ ok: false, reason: 'no-token' });
  });

  it('checks permission BEFORE trusting the oid, so neither alone is enough', async () => {
    const deps = ok({ verify: vi.fn(async () => ({ decoded: { oid: OID }, roles: [], permissions: new Set() })) });
    await expect(callerFromTurn(turn(), deps)).resolves.toEqual({ ok: false, reason: 'forbidden' });
  });
});
