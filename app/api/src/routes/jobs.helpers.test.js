// Tests for the helpers extracted from the create-job (CC 58→16) and update-config
// handlers. Pure helpers are tested directly; the two that read the DB take a
// `pool` argument, so a fake mssql-shim pool suffices (no module mocking).
import { describe, it, expect } from 'vitest';
import {
  mergeConfigForUpdate, validateCreateJobBody, resolveJobConfig,
  resolveUploadFolder, prepareJobConfig, checkSingletonConflict, resolveCreatedBy,
} from './jobs.js';
import {
  splitConfigSecrets, changedHostFields, credentialReentryError, stripServerOwnedKeys,
} from './jobs/helpers.js';

const SECRET_MASK = '••••••••';
const mockPool = (rows) => ({ query: async () => ({ rows }) });

describe('resolveCreatedBy', () => {
  it('prefers preferred_username, then name, then "ui"', () => {
    expect(resolveCreatedBy({ user: { preferred_username: 'alice', name: 'A' } })).toBe('alice');
    expect(resolveCreatedBy({ user: { name: 'Bob' } })).toBe('Bob');
    expect(resolveCreatedBy({})).toBe('ui');
  });
});

describe('validateCreateJobBody', () => {
  it('accepts a valid job type and parses configId to an integer', () => {
    const v = validateCreateJobBody({ jobType: 'csv', configId: '5' });
    expect(v.error).toBeUndefined();
    expect(v.jobType).toBe('csv');
    expect(v.configId).toBe(5);
  });
  it('treats an omitted configId as inline (null)', () => {
    expect(validateCreateJobBody({ jobType: 'csv' }).configId).toBe(null);
  });
  it('rejects an unknown job type', () => {
    expect(validateCreateJobBody({ jobType: 'nope-nope' }).error.status).toBe(400);
  });
  it('rejects a non-positive or non-numeric configId', () => {
    expect(validateCreateJobBody({ jobType: 'csv', configId: 0 }).error.status).toBe(400);
    expect(validateCreateJobBody({ jobType: 'csv', configId: 'abc' }).error.status).toBe(400);
  });
  it('rejects an invalid syncMode', () => {
    expect(validateCreateJobBody({ jobType: 'csv', syncMode: 'weird' }).error.status).toBe(400);
  });
});

describe('mergeConfigForUpdate', () => {
  it('merges the patch and pulls a real clientSecret out for the vault', () => {
    const { mergedConfig, newSecrets, keptFields } = mergeConfigForUpdate({ a: 1 }, { a: 2, clientSecret: 'realsecret' });
    expect(mergedConfig).toEqual({ a: 2 });
    expect(newSecrets).toEqual({ clientSecret: 'realsecret' });
    expect(keptFields).toEqual(['password', 'apiToken', 'cookieString']);
  });
  it('does not treat the mask as a new clientSecret', () => {
    const r = mergeConfigForUpdate({}, { clientSecret: SECRET_MASK });
    expect(r.newSecrets).toEqual({});
    expect(r.keptFields).toContain('clientSecret');
    expect(r.mergedConfig).toEqual({});
  });
  // SEC-2026-09 M-10: password / apiToken / cookieString never stay in the JSON.
  it('pulls password / apiToken / cookieString out of the merged config into newSecrets', () => {
    const { mergedConfig, newSecrets, keptFields } = mergeConfigForUpdate(
      { baseUrl: 'https://x' }, { password: 'pw', apiToken: SECRET_MASK, cookieString: '' });
    expect(mergedConfig).toEqual({ baseUrl: 'https://x' });
    expect(newSecrets).toEqual({ password: 'pw' });
    expect(keptFields).toEqual(['clientSecret', 'apiToken', 'cookieString']);
  });
  it('moves a legacy plaintext field from the stored config into newSecrets when it is kept', () => {
    const r = mergeConfigForUpdate({ password: 'legacy', apiToken: 'oldtok' }, { password: SECRET_MASK, apiToken: 'newtok' });
    expect(r.mergedConfig.password).toBeUndefined();
    expect(r.newSecrets).toEqual({ password: 'legacy', apiToken: 'newtok' });
    expect(r.keptFields).toContain('password');
    expect(r.keptFields).not.toContain('apiToken');
  });
  it('parses a legacy stringified existing config', () => {
    expect(mergeConfigForUpdate(JSON.stringify({ x: 1 }), { y: 2 }).mergedConfig).toEqual({ x: 1, y: 2 });
  });
  it('keeps the stored config when no patch config is sent', () => {
    expect(mergeConfigForUpdate({ x: 1 }, undefined)).toEqual({ mergedConfig: { x: 1 }, newSecrets: {}, keptFields: ['clientSecret', 'password', 'apiToken', 'cookieString'] });
  });
});

describe('splitConfigSecrets', () => {
  it('separates real credential values from the rest, dropping masks and blanks', () => {
    expect(splitConfigSecrets({ a: 1, clientSecret: 's', password: SECRET_MASK, apiToken: '', cookieString: 'c' }))
      .toEqual({ rest: { a: 1 }, secrets: { clientSecret: 's', cookieString: 'c' } });
    expect(splitConfigSecrets(null)).toEqual({ rest: {}, secrets: {} });
  });
});

describe('changedHostFields (M-02)', () => {
  const fields = ['baseUrl', 'tokenEndpoint'];
  it('ignores a path-only change on the same host', () => {
    expect(changedHostFields(fields, { baseUrl: 'https://idp.example.com/a' }, { baseUrl: 'https://IDP.example.com/b/' })).toEqual([]);
  });
  it('flags a host change, a port change and a scheme downgrade', () => {
    expect(changedHostFields(fields, { baseUrl: 'https://idp.example.com' }, { baseUrl: 'https://other.example' })).toEqual(['baseUrl']);
    expect(changedHostFields(fields, { baseUrl: 'https://idp.example.com' }, { baseUrl: 'https://idp.example.com:8443' })).toEqual(['baseUrl']);
    expect(changedHostFields(fields, { tokenEndpoint: 'https://idp.example.com/t' }, { tokenEndpoint: 'http://idp.example.com/t' })).toEqual(['tokenEndpoint']);
  });
  it('flags a host-bearing field that is added or removed', () => {
    expect(changedHostFields(fields, { baseUrl: 'https://a' }, { baseUrl: 'https://a', tokenEndpoint: 'https://t' })).toEqual(['tokenEndpoint']);
    expect(changedHostFields(fields, JSON.stringify({ tokenEndpoint: 'https://t' }), {})).toEqual(['tokenEndpoint']);
  });
  it('compares unparseable values as raw strings', () => {
    expect(changedHostFields(fields, { baseUrl: 'not a url' }, { baseUrl: ' not a url ' })).toEqual([]);
    expect(changedHostFields(fields, { baseUrl: 'not a url' }, { baseUrl: 'still not' })).toEqual(['baseUrl']);
  });
});

describe('credentialReentryError (M-02)', () => {
  it('is null when no host changed or nothing stored is being kept', () => {
    expect(credentialReentryError([], ['clientSecret'])).toBeNull();
    expect(credentialReentryError(['baseUrl'], [])).toBeNull();
  });
  it('names the changed fields and the credentials to re-enter', () => {
    const e = credentialReentryError(['tokenEndpoint'], ['clientSecret', 'password']);
    expect(e.status).toBe(400);
    expect(e.body.reenterFields).toEqual(['clientSecret', 'password']);
    expect(e.body.error).toContain('tokenEndpoint');
    expect(e.body.error).toContain('Re-enter clientSecret, password');
  });
});

describe('stripServerOwnedKeys (H-02)', () => {
  it('drops every _-prefixed key and keeps the rest', () => {
    expect(stripServerOwnedKeys({ _scheduledByConfigId: 3, _syncMode: 'full', _x: 1, baseUrl: 'u', a_b: 2 })).toEqual({ baseUrl: 'u', a_b: 2 });
  });
  it('returns null for a non-object', () => {
    expect(stripServerOwnedKeys(null)).toBeNull();
    expect(stripServerOwnedKeys('x')).toBeNull();
  });
});

describe('prepareJobConfig', () => {
  it('stamps the source configId + syncMode and strips clientSecret', () => {
    const { configJson, inlineSecret } = prepareJobConfig({ clientSecret: 's', foo: 1 }, 7, 'full');
    const stored = JSON.parse(configJson);
    expect(stored).toMatchObject({ foo: 1, _scheduledByConfigId: 7, _syncMode: 'full' });
    expect(stored.clientSecret).toBeUndefined();
    expect(inlineSecret).toBe(null);            // configId present → not an inline secret
  });
  it('vaults an inline clientSecret when there is no configId', () => {
    expect(prepareJobConfig({ clientSecret: 's' }, null, 'delta').inlineSecret).toBe('s');
  });
  it('extracts other secret fields into extraCreds and out of the stored config', () => {
    const { extraCreds, configJson } = prepareJobConfig({ password: 'pw' }, null, 'delta');
    expect(extraCreds.password).toBe('pw');
    expect(JSON.parse(configJson).password).toBeUndefined();
  });
  it('returns null configJson for a null config', () => {
    expect(prepareJobConfig(null, null, 'delta').configJson).toBe(null);
  });
  // SEC-2026-09 H-02: a caller-supplied _scheduledByConfigId never survives on an
  // inline job, and a stored config's stray _ keys are replaced by the server's.
  it('drops a caller-supplied _scheduledByConfigId / _syncMode from an inline config', () => {
    const { configToStore } = prepareJobConfig({ baseUrl: 'u', _scheduledByConfigId: 3, _syncMode: 'full' }, null, 'delta');
    expect(configToStore).toEqual({ baseUrl: 'u', _syncMode: 'delta' });
  });
  it('stamps the real configId over any _scheduledByConfigId stored in the config', () => {
    const { configToStore } = prepareJobConfig({ _scheduledByConfigId: 3, _scheduleIndex: 9 }, 7, 'full');
    expect(configToStore).toEqual({ _scheduledByConfigId: 7, _syncMode: 'full' });
  });
});

describe('resolveJobConfig', () => {
  it('returns the inline config verbatim when there is no configId', async () => {
    expect(await resolveJobConfig(null, { a: 1 }, null)).toEqual({ resolvedConfig: { a: 1 }, configNextRunMode: null });
  });
  it('404s when the stored config is not found', async () => {
    expect((await resolveJobConfig(mockPool([]), null, 5)).error.status).toBe(404);
  });
  it('loads and returns a stored config + its nextRunMode', async () => {
    const r = await resolveJobConfig(mockPool([{ config: { x: 1 }, nextRunMode: 'full' }]), null, 5);
    expect(r.resolvedConfig).toEqual({ x: 1 });
    expect(r.configNextRunMode).toBe('full');
  });
  it('parses a legacy string config column and defaults nextRunMode to delta', async () => {
    const r = await resolveJobConfig(mockPool([{ config: '{"x":2}', nextRunMode: null }]), null, 5);
    expect(r.resolvedConfig).toEqual({ x: 2 });
    expect(r.configNextRunMode).toBe('delta');
  });
});

describe('resolveUploadFolder', () => {
  it('requires a configId (inline configs not supported)', () => {
    const r = resolveUploadFolder('demo', null, {});
    expect(r.error.status).toBe(400);
    expect(r.error.body.error).toMatch(/require a configId/);
  });
  it('errors when the resolved upload folder has no files', () => {
    // A config id whose upload folder does not exist → readdirSync throws → "No files found".
    const r = resolveUploadFolder('demo', 987654321, {});
    expect(r.error.status).toBe(400);
    expect(r.error.body.error).toMatch(/No files found/);
  });
});

describe('checkSingletonConflict', () => {
  it('returns null for a non-singleton job type', async () => {
    expect(await checkSingletonConflict(mockPool([]), 'csv')).toBe(null);
  });
  it('returns 409 when a singleton (demo) job is already active', async () => {
    const r = await checkSingletonConflict(mockPool([{ x: 1 }]), 'demo');
    expect(r.status).toBe(409);
  });
  it('returns null for a singleton type with no active job', async () => {
    expect(await checkSingletonConflict(mockPool([]), 'demo')).toBe(null);
  });
});
