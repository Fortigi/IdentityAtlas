import { describe, it, expect, vi } from 'vitest';
import {
  callerFromToken, mayAsk, withTokenTimeout,
  REQUIRED_PERMISSION, TOKEN_SERVICE_TIMEOUT_MS,
} from './auth.js';

const OID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TOKEN = 'header.payload.signature';

const verifies = (over = {}) => vi.fn(async () => ({
  decoded: { oid: OID }, roles: ['RoleMiner'], permissions: new Set(['data.read.reports']), ...over,
}));

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
    expect(mayAsk(new Set([
      'data.read', 'data.export.ui', 'data.share', 'data.write.tags', 'data.write.reports', 'admin.crawlers',
    ]))).toBe(false);
  });

  it('refuses an empty or missing permission set', () => {
    expect(mayAsk(new Set())).toBe(false);
    expect(mayAsk(null)).toBe(false);
    expect(mayAsk(undefined)).toBe(false);
  });
});

describe('withTokenTimeout', () => {
  it('returns the value when the call answers in time', async () => {
    await expect(withTokenTimeout(Promise.resolve('tok'), 'verify', 1000)).resolves.toBe('tok');
  });

  it('rejects rather than hanging forever, naming the call', async () => {
    // A call that never settles produced a turn that never replied and never
    // logged — no answer, no error, nothing to look at. That is the one failure
    // this bot must not have.
    vi.useFakeTimers();
    try {
      const never = withTokenTimeout(new Promise(() => {}), 'verify', 50);
      const assertion = expect(never).rejects.toThrow(/verify did not answer within 50ms/);
      await vi.advanceTimersByTimeAsync(51);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a real rejection unchanged', async () => {
    await expect(withTokenTimeout(Promise.reject(new Error('401 unauthorised')), 'verify', 1000))
      .rejects.toThrow('401 unauthorised');
  });
});

describe('callerFromToken', () => {
  it('returns the oid from the VERIFIED token', async () => {
    await expect(callerFromToken(TOKEN, { verify: verifies() }))
      .resolves.toEqual({ ok: true, oid: OID, firstName: null });
  });

  it('takes the greeting name from the token, first word only', async () => {
    // The bot opens with "Hi Kees" — from the signed token, never from a
    // database lookup, so the name can never disagree with the account the
    // answer is actually about. Only the first word: "Hi Kees van den Berg"
    // reads like a mail merge.
    const verify = verifies({ decoded: { oid: OID, name: 'Kees van den Berg' } });
    await expect(callerFromToken(TOKEN, { verify })).resolves.toMatchObject({ firstName: 'Kees' });
  });

  it('prefers the given name over splitting the display name', async () => {
    // A display name is not reliably "first last" — "Berg, Kees van den" is
    // the shape a tenant with a surname-first naming policy produces, and
    // splitting it greets somebody as "Berg,".
    const verify = verifies({ decoded: { oid: OID, given_name: 'Kees', name: 'Berg, Kees van den' } });
    await expect(callerFromToken(TOKEN, { verify })).resolves.toMatchObject({ firstName: 'Kees' });
  });

  it('has no name rather than a blank one when the token carries neither', async () => {
    // null, not '' — the greeting branches on it to leave the name out, and an
    // empty string would send "Hi , got your message".
    for (const decoded of [{ oid: OID }, { oid: OID, name: '   ' }, { oid: OID, name: '' }]) {
      await expect(callerFromToken(TOKEN, { verify: verifies({ decoded }) }))
        .resolves.toMatchObject({ firstName: null });
    }
  });

  it.each([[null, 'null'], [undefined, 'undefined'], ['', 'empty string']])(
    'reports no-token for %s, without logging an error', async (token) => {
      // The sign-in did not complete. Ordinary, and the prompt has already said
      // so — logging it as an error trains whoever reads the log to ignore the
      // ones that matter.
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const verify = verifies();

      await expect(callerFromToken(token, { verify })).resolves.toEqual({ ok: false, reason: 'no-token' });
      expect(verify).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
      err.mockRestore();
    },
  );

  it('refuses a token that does not verify, and says so in the log', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const verify = vi.fn(async () => { throw new Error('Token issued by unexpected tenant'); });

    await expect(callerFromToken(TOKEN, { verify })).resolves.toEqual({ ok: false, reason: 'invalid-token' });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('refuses rather than hanging when verification never answers', async () => {
    // Verifying fetches the tenant's signing keys inside jsonwebtoken's key
    // callback. If that fetch stalls, the callback never fires and the promise
    // never settles — the exact shape of silence this timeout exists to break.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const pending = callerFromToken(TOKEN, { verify: vi.fn(() => new Promise(() => {})) });
      await vi.advanceTimersByTimeAsync(TOKEN_SERVICE_TIMEOUT_MS + 1);

      await expect(pending).resolves.toEqual({ ok: false, reason: 'invalid-token' });
      expect(err.mock.calls.join(' ')).toMatch(/did not answer within/);
    } finally {
      vi.useRealTimers();
      err.mockRestore();
    }
  });

  it('refuses a verified token whose holder may not ask', async () => {
    const verify = verifies({ roles: ['Servicedesk'], permissions: new Set(['data.read']) });
    await expect(callerFromToken(TOKEN, { verify })).resolves.toEqual({ ok: false, reason: 'forbidden' });
  });

  it('refuses a verified APPLICATION token — it has no person to answer as', async () => {
    // A valid token with every permission and no oid. Checking permissions but
    // not the oid would let this through and resolve a caller of `undefined`.
    const verify = verifies({ decoded: { roles: ['Admin'] }, permissions: new Set(['*']) });
    await expect(callerFromToken(TOKEN, { verify })).resolves.toEqual({ ok: false, reason: 'invalid-token' });
  });

  it.each([['', 'empty string'], [null, 'null'], [12345, 'a number']])(
    'refuses a token whose oid is %j (%s)', async (oid) => {
      const verify = verifies({ decoded: { oid }, permissions: new Set(['*']) });
      await expect(callerFromToken(TOKEN, { verify })).resolves.toEqual({ ok: false, reason: 'invalid-token' });
    },
  );

  it('checks permission BEFORE trusting the oid, so neither alone is enough', async () => {
    const verify = verifies({ permissions: new Set() });
    await expect(callerFromToken(TOKEN, { verify })).resolves.toEqual({ ok: false, reason: 'forbidden' });
  });
});
