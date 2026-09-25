import { describe, it, expect, vi } from 'vitest';
import { resolveCaller, isUuid, callerContextBlock, callerScopeFilter, ME } from './caller.js';

const OID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const row = (over = {}) => ({
  id: OID, displayName: 'Kees van den Berg', email: 'kees@example.com',
  jobTitle: 'Partner', department: 'Advies', ...over,
});

describe('resolveCaller', () => {
  it('returns the account behind the object id', async () => {
    const q = vi.fn(async () => row());
    await expect(resolveCaller(OID, q)).resolves.toEqual({
      principalId: OID,
      displayName: 'Kees van den Berg',
      email: 'kees@example.com',
      jobTitle: 'Partner',
      department: 'Advies',
    });
  });

  it('looks the caller up by PRIMARY KEY, never by name or email', async () => {
    // The whole safety property of caller resolution. A query that matched on
    // displayName would satisfy the test above and be catastrophically wrong.
    const q = vi.fn(async () => row());
    await resolveCaller(OID, q);

    const [sql, params] = q.mock.calls[0];
    expect(params).toEqual([OID]);
    expect(sql).toMatch(/WHERE\s+"id"\s*=\s*\$1/);
    expect(sql).not.toMatch(/displayName"\s*=|email"\s*=|ILIKE|similarity/i);
  });

  it('excludes soft-deleted accounts and non-user principals', async () => {
    // A leaver's account and a service principal both have a uuid id; neither
    // is a person who may ask questions.
    const q = vi.fn(async () => row());
    await resolveCaller(OID, q);

    const [sql] = q.mock.calls[0];
    expect(sql).toMatch(/"deletedAt"\s+IS\s+NULL/);
    expect(sql).toMatch(/"principalType"\s*=\s*'User'/);
  });

  it('returns null when nothing matched, and never a partial caller', async () => {
    await expect(resolveCaller(OID, vi.fn(async () => null))).resolves.toBeNull();
    await expect(resolveCaller(OID, vi.fn(async () => undefined))).resolves.toBeNull();
  });

  it('rejects a non-uuid without going near the database', async () => {
    // Postgres raises 22P02 on a bad uuid literal, which would surface as a 500
    // ("the bot is broken") instead of "this token is not one of ours".
    const q = vi.fn();
    for (const bad of ['', 'not-a-uuid', "' OR 1=1 --", null, undefined, 42]) {
      await expect(resolveCaller(bad, q)).resolves.toBeNull();
    }
    expect(q).not.toHaveBeenCalled();
  });

  it('normalises missing optional columns to null rather than undefined', async () => {
    const caller = await resolveCaller(OID, vi.fn(async () => ({ id: OID })));
    expect(caller).toEqual({ principalId: OID, displayName: null, email: null, jobTitle: null, department: null });
  });
});

describe('isUuid', () => {
  it('accepts a canonical uuid in either case', () => {
    expect(isUuid(OID)).toBe(true);
    expect(isUuid(OID.toUpperCase())).toBe(true);
  });

  it.each([
    ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee', 'one character short'],
    ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeeee', 'one character long'],
    [`${OID} `, 'trailing space'],
    [`${OID}\n${OID}`, 'two uuids on separate lines'],
    ['aaaaaaaa-bbbb-cccc-dddd-gggggggggggg', 'non-hex characters'],
  ])('rejects %j (%s)', (value) => {
    expect(isUuid(value)).toBe(false);
  });
});

describe('callerContextBlock', () => {
  const caller = { principalId: OID, displayName: 'Kees van den Berg' };

  it('names the caller and their account id, and explains the sentinel', () => {
    const block = callerContextBlock(caller);
    expect(block).toContain('Kees van den Berg');
    expect(block).toContain(OID);
    expect(block).toContain(ME);
  });

  it('tells the model what "my" and "mijn" refer to, in both languages', () => {
    const block = callerContextBlock(caller);
    expect(block).toContain('"my"');
    expect(block).toContain('"mijn"');
  });

  it('tells the model NOTHING about the data — no counts, no names but the caller\'s own', () => {
    // The report generator's published privacy property is that the model never
    // receives rows, values or counts. This block is the one thing the bot adds
    // to the prompt, so it is the one place that property can be broken.
    const block = callerContextBlock(caller);
    expect(block).not.toMatch(/\b\d+\s+(direct reports|groups|members|accounts|resources)/i);
    expect(block.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)).toEqual([OID]);
  });

  it('still produces a usable block for an account with no display name', () => {
    const block = callerContextBlock({ principalId: OID, displayName: null });
    expect(block).toContain(OID);
    expect(block).not.toContain('null');
  });
});

describe('callerScopeFilter', () => {
  it('returns null — v1 knows who is asking but does not restrict what they see', () => {
    // Pinned deliberately. This is the POC's documented gap; when it starts
    // returning a condition, that is a behaviour change that must be noticed
    // here rather than discovered in production.
    expect(callerScopeFilter({ principalId: OID }, { entity: 'user', conditions: [] })).toBeNull();
  });
});
