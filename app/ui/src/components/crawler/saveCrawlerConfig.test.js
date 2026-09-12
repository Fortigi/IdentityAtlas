// saveCrawlerConfig — the one write behind every crawler wizard's save button.
//
// The decisions worth pinning: PATCH an existing config vs POST a new one (a
// wrong choice here either duplicates a crawler or silently overwrites the
// wrong one), that crawlerType is sent ONLY on create, and that a failure
// surfaces the API's message rather than a generic one.
import { describe, it, expect, vi } from 'vitest';
import saveCrawlerConfig from './saveCrawlerConfig';

const okResponse = (body = { id: 7 }) => ({ ok: true, status: 200, json: async () => body });

describe('saveCrawlerConfig — create', () => {
  it('POSTs to the collection with the crawler type', async () => {
    const authFetch = vi.fn(async () => okResponse());
    await saveCrawlerConfig({ authFetch, crawlerType: 'preview-type', displayName: 'My SCIM', config: { baseUrl: 'x' } });

    const [url, opts] = authFetch.mock.calls[0];
    expect(url).toBe('/api/admin/crawler-configs');
    expect(opts.method).toBe('POST');
    // The API only parses a JSON body when it is announced as one.
    expect(opts.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(opts.body)).toEqual({
      crawlerType: 'preview-type', displayName: 'My SCIM', config: { baseUrl: 'x' },
    });
  });

  it('trims the display name', async () => {
    const authFetch = vi.fn(async () => okResponse());
    await saveCrawlerConfig({ authFetch, crawlerType: 'preview-type', displayName: '  padded  ', config: {} });
    expect(JSON.parse(authFetch.mock.calls[0][1].body).displayName).toBe('padded');
  });

  it('tolerates a missing display name rather than throwing on .trim()', async () => {
    const authFetch = vi.fn(async () => okResponse());
    await saveCrawlerConfig({ authFetch, crawlerType: 'preview-type', config: {} });
    expect(JSON.parse(authFetch.mock.calls[0][1].body).displayName).toBe('');
  });
});

describe('saveCrawlerConfig — update', () => {
  it('PATCHes the existing config by id, and does NOT resend crawlerType', async () => {
    const authFetch = vi.fn(async () => okResponse());
    await saveCrawlerConfig({ authFetch, crawlerType: 'preview-type', configId: 42, displayName: 'Edited', config: { a: 1 } });

    const [url, opts] = authFetch.mock.calls[0];
    expect(url).toBe('/api/admin/crawler-configs/42');
    expect(opts.method).toBe('PATCH');
    expect(opts.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = JSON.parse(opts.body);
    expect(body).toEqual({ displayName: 'Edited', config: { a: 1 } });
    expect(body.crawlerType).toBeUndefined();
  });

  it('treats configId 0 as "no id" — it is not a real row id', async () => {
    const authFetch = vi.fn(async () => okResponse());
    await saveCrawlerConfig({ authFetch, crawlerType: 'preview-type', configId: 0, displayName: 'New', config: {} });
    expect(authFetch.mock.calls[0][0]).toBe('/api/admin/crawler-configs');
  });
});

describe('saveCrawlerConfig — failure', () => {
  it('throws the API error message so the wizard can show it', async () => {
    const authFetch = vi.fn(async () => ({
      ok: false, status: 403, json: async () => ({ error: "that type is experimental." }),
    }));
    await expect(saveCrawlerConfig({ authFetch, crawlerType: 'preview-type', displayName: 'x', config: {} }))
      .rejects.toThrow("that type is experimental.");
  });

  it('falls back to the status code when the body carries no message', async () => {
    const authFetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(saveCrawlerConfig({ authFetch, crawlerType: 'preview-type', displayName: 'x', config: {} }))
      .rejects.toThrow('HTTP 503');
  });

  it('still reports the status code when the error body is not JSON at all', async () => {
    const authFetch = vi.fn(async () => ({
      ok: false, status: 502, json: async () => { throw new SyntaxError('not json'); },
    }));
    await expect(saveCrawlerConfig({ authFetch, crawlerType: 'preview-type', displayName: 'x', config: {} }))
      .rejects.toThrow('HTTP 502');
  });

  it('resolves even when a successful response has no JSON body', async () => {
    const authFetch = vi.fn(async () => ({
      ok: true, status: 204, json: async () => { throw new SyntaxError('no content'); },
    }));
    await expect(saveCrawlerConfig({ authFetch, crawlerType: 'preview-type', displayName: 'x', config: {} }))
      .resolves.toEqual({});
  });
});
