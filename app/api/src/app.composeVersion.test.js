// The /api/version endpoint tells the Dashboard whether the operator's
// docker-compose.prod.yml is older than the floor this image requires
// (MIN_COMPOSE_FILE_VERSION), so a stale file gets an "outdated — re-download"
// warning. The floor was raised to 2 for the H-05 fix: version-1 compose files
// may still bind /var/run/docker.sock into the web container (a host-takeover
// primitive) and expose Postgres on all interfaces, so they must be flagged.

import { describe, it, expect, afterEach, vi } from 'vitest';
vi.hoisted(() => { process.env.USE_SQL = 'true'; });
import request from 'supertest';
import { createApp } from './app.js';

describe('/api/version — compose file freshness', () => {
  const app = createApp();
  const original = process.env.COMPOSE_FILE_VERSION;

  afterEach(() => {
    if (original === undefined) delete process.env.COMPOSE_FILE_VERSION;
    else process.env.COMPOSE_FILE_VERSION = original;
  });

  it('flags a version-1 compose (which may still mount the Docker socket) as outdated', async () => {
    process.env.COMPOSE_FILE_VERSION = '1';
    const res = await request(app).get('/api/version');
    expect(res.status).toBe(200);
    expect(res.body.minComposeFileVersion).toBe(2);
    expect(res.body.composeFileVersion).toBe(1);
    expect(res.body.composeFileOutdated).toBe(true);
  });

  it('treats the current version-2 compose as up to date', async () => {
    process.env.COMPOSE_FILE_VERSION = '2';
    const res = await request(app).get('/api/version');
    expect(res.body.composeFileVersion).toBe(2);
    expect(res.body.composeFileOutdated).toBe(false);
  });

  it('does not false-alarm when the compose version is unknown', async () => {
    delete process.env.COMPOSE_FILE_VERSION;
    const res = await request(app).get('/api/version');
    expect(res.body.composeFileVersion).toBeNull();
    expect(res.body.composeFileOutdated).toBe(false);
  });
});
