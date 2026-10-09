// The public spec endpoint serves openapi.yaml parsed into JSON. A parser that
// failed would be swallowed by app.js's try/catch and silently drop the route,
// so assert the route exists and that the body is the whole spec.

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'fs';
import { createApp } from './app.js';

const SPEC = readFileSync(new URL('./openapi.yaml', import.meta.url), 'utf8');
const pathCount = SPEC.split('\n').filter(line => /^ {2}\/\S*:\s*$/.test(line)).length;

describe('GET /api/openapi.json', () => {
  it('serves the full OpenAPI spec as JSON', async () => {
    const res = await request(createApp()).get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.openapi).toBe('3.0.3');
    expect(res.body.paths['/ingest/systems']).toHaveProperty('post');
    expect(Object.keys(res.body.paths)).toHaveLength(pathCount);
  });
});
