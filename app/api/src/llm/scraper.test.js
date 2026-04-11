// Tests for the URL scraper.
// Network calls are mocked via global fetch.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scrapeOne, buildLLMContextFromScrapes } from './scraper.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

function mockResponse({ ok = true, status = 200, contentType = 'text/html', body = '' }) {
  return {
    ok,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => Buffer.from(body, 'utf8').buffer,
  };
}

describe('scrapeOne', () => {
  it('rejects non-http URLs', async () => {
    const r = await scrapeOne('file:///etc/passwd');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Only http/);
  });

  it('rejects malformed URLs', async () => {
    const r = await scrapeOne('not a url');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Invalid URL');
  });

  it('strips HTML tags and returns text', async () => {
    global.fetch = vi.fn(async () => mockResponse({
      contentType: 'text/html; charset=utf-8',
      body: '<html><body><script>alert(1)</script><h1>Hello</h1><p>World</p></body></html>',
    }));
    const r = await scrapeOne('https://example.com');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('Hello');
    expect(r.text).toContain('World');
    expect(r.text).not.toContain('alert');
    expect(r.text).not.toContain('<h1>');
  });

  it('attaches Basic auth header when username/password is supplied', async () => {
    global.fetch = vi.fn(async (_url, init) => {
      expect(init.headers.Authorization).toMatch(/^Basic /);
      const decoded = Buffer.from(init.headers.Authorization.slice(6), 'base64').toString();
      expect(decoded).toBe('user:pass');
      return mockResponse({ contentType: 'text/plain', body: 'ok' });
    });
    const r = await scrapeOne('https://wiki/internal', { username: 'user', password: 'pass' });
    expect(r.ok).toBe(true);
  });

  it('attaches Bearer auth when bearer is supplied', async () => {
    global.fetch = vi.fn(async (_url, init) => {
      expect(init.headers.Authorization).toBe('Bearer token123');
      return mockResponse({ contentType: 'text/plain', body: 'ok' });
    });
    await scrapeOne('https://api/v1', { bearer: 'token123' });
  });

  it('reports HTTP errors without throwing', async () => {
    global.fetch = vi.fn(async () => mockResponse({ ok: false, status: 403 }));
    const r = await scrapeOne('https://x');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/HTTP 403/);
  });

  it('rejects non-text content types', async () => {
    global.fetch = vi.fn(async () => mockResponse({ contentType: 'image/png', body: 'binary' }));
    const r = await scrapeOne('https://x.png');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unsupported content-type/);
  });
});

describe('buildLLMContextFromScrapes', () => {
  it('joins successful scrapes with source delimiters', () => {
    const ctx = buildLLMContextFromScrapes([
      { url: 'a', ok: true, text: 'first' },
      { url: 'b', ok: false, error: 'fail' },
      { url: 'c', ok: true, text: 'second' },
    ]);
    expect(ctx).toContain('--- SOURCE: a ---');
    expect(ctx).toContain('first');
    expect(ctx).toContain('--- SOURCE: c ---');
    expect(ctx).toContain('second');
    expect(ctx).not.toContain('fail');
  });

  it('returns empty string when nothing is OK', () => {
    expect(buildLLMContextFromScrapes([])).toBe('');
    expect(buildLLMContextFromScrapes([{ url: 'a', ok: false }])).toBe('');
  });
});
