import { describe, it, expect, beforeEach } from 'vitest';
import {
  armStartupGate,
  markSchemaReady,
  markSchemaFailed,
  isSchemaReady,
  getStartupStatus,
  _resetForTest,
} from './startupState.js';

describe('startupState', () => {
  beforeEach(() => _resetForTest());

  it('is ready by default (inert until armed) so tests/mock mode are unaffected', () => {
    expect(isSchemaReady()).toBe(true);
    expect(getStartupStatus()).toMatchObject({ armed: false, schemaReady: false });
  });

  it('closes the gate once armed, opens it when the schema is marked ready', () => {
    armStartupGate();
    expect(isSchemaReady()).toBe(false);
    markSchemaReady();
    expect(isSchemaReady()).toBe(true);
    expect(getStartupStatus()).toMatchObject({ armed: true, schemaReady: true });
  });

  it('records failures, counts attempts, and keeps the gate closed', () => {
    armStartupGate();
    markSchemaFailed(new Error('boom'));
    expect(isSchemaReady()).toBe(false);
    expect(getStartupStatus()).toMatchObject({ failedAttempts: 1, lastError: 'boom' });

    markSchemaFailed(new Error('again'));
    expect(getStartupStatus().failedAttempts).toBe(2);
    expect(getStartupStatus().lastError).toBe('again');
  });

  it('coerces a non-Error failure to a string', () => {
    armStartupGate();
    markSchemaFailed('plain string failure');
    expect(getStartupStatus().lastError).toBe('plain string failure');
  });

  it('markSchemaReady clears a prior error and opens the gate', () => {
    armStartupGate();
    markSchemaFailed(new Error('boom'));
    markSchemaReady();
    expect(isSchemaReady()).toBe(true);
    expect(getStartupStatus().lastError).toBeNull();
  });
});
