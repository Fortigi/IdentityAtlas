// Unit tests for the export base-URL resolver (finding M-09). The workbook
// embeds a live read token, so the base URL must never be derived from an
// attacker-controllable header unless the operator has explicitly opted into
// trusting a reverse proxy.

import { describe, it, expect } from 'vitest';
import { resolveExportBaseUrl } from './exportBaseUrl.js';

// Minimal Express-request stub. `headers` keys must be lowercase.
function fakeReq({ protocol = 'http', headers = {} } = {}) {
  return {
    protocol,
    get(name) {
      return headers[name.toLowerCase()];
    },
  };
}

describe('resolveExportBaseUrl', () => {
  it('uses the direct request host by default (local / no config)', () => {
    const req = fakeReq({ headers: { host: 'localhost:3001' } });
    expect(resolveExportBaseUrl(req, {})).toBe('http://localhost:3001/api');
  });

  it('IGNORES X-Forwarded-Host when TRUST_PROXY is not set (anti-spoofing)', () => {
    const req = fakeReq({
      headers: { host: 'atlas.internal:3001', 'x-forwarded-host': 'evil.example.com' },
    });
    expect(resolveExportBaseUrl(req, {})).toBe('http://atlas.internal:3001/api');
  });

  it('honours X-Forwarded-* only when TRUST_PROXY=true', () => {
    const req = fakeReq({
      headers: {
        host: 'atlas.internal:3001',
        'x-forwarded-host': 'atlas.example.com',
        'x-forwarded-proto': 'https',
      },
    });
    expect(resolveExportBaseUrl(req, { TRUST_PROXY: 'true' }))
      .toBe('https://atlas.example.com/api');
  });

  it('takes only the first hop of a comma-separated X-Forwarded-Host', () => {
    const req = fakeReq({
      headers: { host: 'atlas.internal', 'x-forwarded-host': 'atlas.example.com, evil.com' },
    });
    expect(resolveExportBaseUrl(req, { TRUST_PROXY: 'true' }))
      .toBe('http://atlas.example.com/api');
  });

  it('PUBLIC_BASE_URL is authoritative and overrides everything', () => {
    const req = fakeReq({
      headers: { host: 'atlas.internal', 'x-forwarded-host': 'evil.com' },
    });
    expect(resolveExportBaseUrl(req, { TRUST_PROXY: 'true', PUBLIC_BASE_URL: 'https://atlas.example.com' }))
      .toBe('https://atlas.example.com/api');
  });

  it('trims a trailing slash from PUBLIC_BASE_URL before appending /api', () => {
    const req = fakeReq({ headers: { host: 'x' } });
    expect(resolveExportBaseUrl(req, { PUBLIC_BASE_URL: 'https://atlas.example.com/' }))
      .toBe('https://atlas.example.com/api');
  });

  it('derives https from the server-side BEHIND_TLS flag (proxy preserving Host)', () => {
    const req = fakeReq({ protocol: 'http', headers: { host: 'atlas.example.com' } });
    expect(resolveExportBaseUrl(req, { BEHIND_TLS: 'true' }))
      .toBe('https://atlas.example.com/api');
  });

  it('rejects a spoofed host containing CRLF / smuggled characters', () => {
    const req = fakeReq({
      headers: { host: 'good.com', 'x-forwarded-host': 'evil.com/\r\nSet-Cookie: x=1' },
    });
    expect(() => resolveExportBaseUrl(req, { TRUST_PROXY: 'true' })).toThrow();
  });

  it('rejects when no host is available', () => {
    const req = fakeReq({ headers: {} });
    expect(() => resolveExportBaseUrl(req, {})).toThrow();
  });
});
