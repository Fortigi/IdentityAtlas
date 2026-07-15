// Tests for the helpers extracted from the create-job (CC 58→16) and update-config
// handlers. Pure helpers are tested directly; the two that read the DB take a
// `pool` argument, so a fake mssql-shim pool suffices (no module mocking).
import { describe, it, expect } from 'vitest';
import {
  mergeConfigForUpdate, validateCreateJobBody, resolveJobConfig,
  resolveUploadFolder, prepareJobConfig, checkSingletonConflict, resolveCreatedBy,
} from './jobs.js';

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
    const { mergedConfig, newSecret } = mergeConfigForUpdate({ a: 1 }, { a: 2, clientSecret: 'realsecret' });
    expect(mergedConfig).toMatchObject({ a: 2 });
    expect(mergedConfig.clientSecret).toBeUndefined();
    expect(newSecret).toBe('realsecret');
  });
  it('does not treat the mask as a new clientSecret', () => {
    expect(mergeConfigForUpdate({}, { clientSecret: SECRET_MASK }).newSecret).toBe(null);
  });
  it('keeps the existing secret field when the incoming one is masked/blank', () => {
    expect(mergeConfigForUpdate({ password: 'keepme' }, { password: SECRET_MASK }).mergedConfig.password).toBe('keepme');
  });
  it('parses a legacy stringified existing config', () => {
    expect(mergeConfigForUpdate(JSON.stringify({ x: 1 }), { y: 2 }).mergedConfig).toEqual({ x: 1, y: 2 });
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
