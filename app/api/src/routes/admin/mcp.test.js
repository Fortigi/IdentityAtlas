import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../../test-utils/routeTestKit.js';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import mcpAdminRouter from './mcp.js';

const app = mountRouter(mcpAdminRouter);

beforeEach(() => { query.mockReset(); process.env.PUBLIC_BASE_URL = 'https://atlas.example.com'; });
afterEach(() => { delete process.env.PUBLIC_BASE_URL; });

describe('GET /api/admin/mcp', () => {
  it('gives the URL and scope to configure a client with, and the recent calls', async () => {
    query.mockResolvedValue({ rows: [{ id: 2, tool: 'run_report' }] });
    const res = await request(app).get('/api/admin/mcp?limit=10').expect(200);
    expect(res.body).toEqual({
      configured: true,
      url: 'https://atlas.example.com/mcp',
      scope: 'https://atlas.example.com/mcp/Mcp.Read',
      calls: [{ id: 2, tool: 'run_report' }],
    });
    expect(query.mock.calls[0][1]).toEqual([10]);
  });

  it('says the server is not configured, with no URL or scope to copy, while PUBLIC_BASE_URL is unset', async () => {
    delete process.env.PUBLIC_BASE_URL;
    query.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/api/admin/mcp').set('Host', 'atlas.attacker.example').expect(200);
    expect(res.body).toEqual({ configured: false, url: null, scope: null, calls: [] });
  });

  it('500s with a generic message when the log cannot be read', async () => {
    query.mockRejectedValue(new Error('relation "McpToolCalls" does not exist'));
    const res = await request(app).get('/api/admin/mcp').expect(500);
    expect(res.body.error).toBe('Failed to read the MCP log');
  });
});
