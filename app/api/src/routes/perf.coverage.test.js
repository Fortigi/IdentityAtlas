// Unit tests for routes/perf.js — performance metrics API. The collector
// module is mocked so we can drive isEnabled() and the data accessors. Auth
// is disabled by default so the admin gates on clear/toggle pass through.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

const isEnabled = vi.fn();
const enable = vi.fn();
const disable = vi.fn();
const summarize = vi.fn(() => ({ routes: {} }));
const recent = vi.fn(() => []);
const slowest = vi.fn(() => []);
const clear = vi.fn();
vi.mock('../perf/collector.js', () => ({
  isEnabled: (...a) => isEnabled(...a),
  enable: (...a) => enable(...a),
  disable: (...a) => disable(...a),
  summarize: (...a) => summarize(...a),
  recent: (...a) => recent(...a),
  slowest: (...a) => slowest(...a),
  clear: (...a) => clear(...a),
}));

const { default: router } = await import('./perf.js');
const app = mountRouter(router);

beforeEach(() => {
  isEnabled.mockReset();
  enable.mockClear();
  disable.mockClear();
  summarize.mockClear();
  recent.mockClear();
  slowest.mockClear();
  clear.mockClear();
  summarize.mockReturnValue({ routes: {} });
  recent.mockReturnValue([{ route: '/x' }]);
  slowest.mockReturnValue([{ route: '/y' }]);
});

describe('GET /perf (summary)', () => {
  it('returns disabled message when collector off', async () => {
    isEnabled.mockReturnValue(false);
    const res = await request(app).get('/api/perf');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  it('returns the summary when enabled', async () => {
    isEnabled.mockReturnValue(true);
    const res = await request(app).get('/api/perf');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, routes: {} });
  });
});

describe('GET /perf/recent', () => {
  it('returns empty data when disabled', async () => {
    isEnabled.mockReturnValue(false);
    const res = await request(app).get('/api/perf/recent');
    expect(res.body).toMatchObject({ enabled: false, data: [] });
  });

  it('clamps n and returns data when enabled', async () => {
    isEnabled.mockReturnValue(true);
    const res = await request(app).get('/api/perf/recent?n=9999');
    expect(res.status).toBe(200);
    expect(recent).toHaveBeenCalledWith(200); // clamped to max
    expect(res.body.data).toHaveLength(1);
  });
});

describe('GET /perf/slow', () => {
  it('returns empty data when disabled', async () => {
    isEnabled.mockReturnValue(false);
    const res = await request(app).get('/api/perf/slow');
    expect(res.body).toMatchObject({ enabled: false, data: [] });
  });

  it('clamps n and returns data when enabled', async () => {
    isEnabled.mockReturnValue(true);
    const res = await request(app).get('/api/perf/slow?n=9999');
    expect(res.status).toBe(200);
    expect(slowest).toHaveBeenCalledWith(100); // clamped to max
  });
});

describe('GET /perf/export', () => {
  it('returns disabled when off', async () => {
    isEnabled.mockReturnValue(false);
    const res = await request(app).get('/api/perf/export');
    expect(res.body).toMatchObject({ enabled: false });
  });

  it('returns a downloadable export when enabled', async () => {
    isEnabled.mockReturnValue(true);
    const res = await request(app).get('/api/perf/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.body).toMatchObject({ enabled: true });
    expect(res.body).toHaveProperty('summary');
    expect(res.body).toHaveProperty('requests');
  });
});

describe('POST /perf/clear', () => {
  it('clears metrics', async () => {
    isEnabled.mockReturnValue(true);
    const res = await request(app).post('/api/perf/clear');
    expect(res.status).toBe(200);
    expect(clear).toHaveBeenCalled();
  });
});

describe('POST /perf/toggle', () => {
  it('400 when enabled flag is not a boolean', async () => {
    const res = await request(app).post('/api/perf/toggle').send({ enabled: 'yes' });
    expect(res.status).toBe(400);
  });

  it('enables the collector', async () => {
    isEnabled.mockReturnValue(true);
    const res = await request(app).post('/api/perf/toggle').send({ enabled: true });
    expect(res.status).toBe(200);
    expect(enable).toHaveBeenCalled();
  });

  it('disables the collector', async () => {
    isEnabled.mockReturnValue(false);
    const res = await request(app).post('/api/perf/toggle').send({ enabled: false });
    expect(res.status).toBe(200);
    expect(disable).toHaveBeenCalled();
  });
});
