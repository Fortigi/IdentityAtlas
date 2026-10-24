// Unit tests for the per-connection session defaults (SEC-2026-09 M-07).

import { describe, it, expect, vi } from 'vitest';
import { idleInTransactionTimeoutMs, applyConnectionDefaults } from './connectionDefaults.js';

describe('idleInTransactionTimeoutMs', () => {
  it('defaults to ten minutes', () => {
    expect(idleInTransactionTimeoutMs({})).toBe(600000);
    expect(idleInTransactionTimeoutMs({ PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: '  ' })).toBe(600000);
  });

  it('honours an override, including 0 (disabled)', () => {
    expect(idleInTransactionTimeoutMs({ PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: '120000' })).toBe(120000);
    expect(idleInTransactionTimeoutMs({ PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: '0' })).toBe(0);
  });

  it('falls back to the default for a negative or non-numeric value', () => {
    expect(idleInTransactionTimeoutMs({ PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: '-1' })).toBe(600000);
    expect(idleInTransactionTimeoutMs({ PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: 'soon' })).toBe(600000);
  });
});

describe('applyConnectionDefaults', () => {
  it('sets the idle-in-transaction timeout on the connection (and no statement_timeout)', async () => {
    const client = { query: vi.fn(async () => ({})) };
    await applyConnectionDefaults(client, 600000);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith('SET idle_in_transaction_session_timeout = 600000');
  });

  it('logs and carries on when the server refuses the setting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = { query: vi.fn(async () => { throw new Error('unrecognized configuration parameter'); }) };
    await expect(applyConnectionDefaults(client, 1)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Could not set idle_in_transaction_session_timeout:', 'unrecognized configuration parameter');
    warn.mockRestore();
  });
});
