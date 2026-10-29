// End-to-end tests of /mcp through the real MCP SDK transport: discovery, every
// way the sign-in gate refuses, and what a permitted caller can list and call.
// Entra is replaced by a mocked verifyEntraAccessToken; the role → permission
// mapping is the real resolver over a test mapping.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const state = vi.hoisted(() => ({ authEnabled: true, featureOn: true, mapping: {} }));

vi.mock('../config/authConfig.js', () => ({
  isAuthEnabled: () => state.authEnabled,
  getJwksClient: () => ({}),
  getTenantId: () => 'tenant-1',
  getClientId: () => 'client-1',
  getRequiredRoles: () => null,
  getRolePermissions: () => state.mapping,
}));
vi.mock('../featureFlags.js', () => ({ isFeatureEnabled: async (name) => name === 'mcpServer' && state.featureOn }));
vi.mock('../middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal()),
  verifyEntraAccessToken: vi.fn(),
}));
vi.mock('../db/connection.js');

import { query, queryOne } from '../db/connection.js';
import { verifyEntraAccessToken } from '../middleware/auth.js';
import { registerReport } from '../reports/registry.js';
import { createMcpRouter } from './router.js';

const app = express();
app.use(express.json());
app.use(createMcpRouter({ version: '9.9.9' }));

const BASE = 'https://atlas.example.com';
const ACCEPT = 'application/json, text/event-stream';

function rpc(method, params, token = 'tok') {
  const req = request(app).post('/mcp').set('Accept', ACCEPT).set('User-Agent', 'Claude-User');
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send({ jsonrpc: '2.0', id: 1, method, params });
}

const claims = (roles, scp = 'Mcp.Read') => ({ oid: '11111111-1111-1111-1111-111111111111', preferred_username: 'ada@example.com', roles, scp, tid: 'tenant-1' });

let unregister;
beforeEach(() => {
  process.env.PUBLIC_BASE_URL = BASE;
  state.authEnabled = true;
  state.featureOn = true;
  state.mapping = {
    Admin: ['*'],
    Reader: ['mcp.use', 'data.read'],
    Asker: ['mcp.use', 'data.read', 'data.read.reports'],
    NoMcp: ['data.read', 'data.read.reports'],
  };
  verifyEntraAccessToken.mockReset();
  query.mockReset();
  queryOne.mockReset();
  query.mockResolvedValue({ rows: [] });
  queryOne.mockResolvedValue(null);
  unregister = registerReport({
    name: 'mcp-test-report', displayName: 'MCP test report', description: 'rows for the test', form: 'list',
    columns: [{ key: 'displayName', label: 'Name' }],
    run: async (params) => ({
      rows: Array.from({ length: 7 }, (_, i) => ({ displayName: `${params.prefix ?? 'row'}-${i}`, _entity: { kind: 'user', id: `u${i}` } })),
      notices: [{ severity: 'info', text: 'computed for the test' }],
    }),
  });
});
afterEach(() => {
  unregister();
  delete process.env.PUBLIC_BASE_URL;
});

describe('availability', () => {
  it('404s the endpoint and its metadata while sign-in is off, even with the feature on', async () => {
    state.authEnabled = false;
    await request(app).get('/.well-known/oauth-protected-resource/mcp').expect(404);
    await rpc('tools/list').expect(404);
    expect(verifyEntraAccessToken).not.toHaveBeenCalled();
  });

  it('404s while the feature is off, even with sign-in on', async () => {
    state.featureOn = false;
    await request(app).get('/.well-known/oauth-protected-resource').expect(404);
    await rpc('tools/list').expect(404);
  });
});

describe('discovery', () => {
  it('names this tenant as the authorization server and the MCP URL as the resource, at both paths', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const res = await request(app).get(path).expect(200);
      expect(res.body).toEqual({
        resource: `${BASE}/mcp`,
        authorization_servers: ['https://login.microsoftonline.com/tenant-1/v2.0'],
        scopes_supported: [`${BASE}/mcp/Mcp.Read`],
        bearer_methods_supported: ['header'],
        resource_name: 'Identity Atlas',
      });
    }
  });

  it('answers a call without a token with 401 and a challenge pointing at the metadata', async () => {
    const res = await rpc('tools/list', {}, null).expect(401);
    expect(res.headers['www-authenticate']).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="${BASE}/mcp/Mcp.Read"`,
    );
  });
});

describe('the sign-in gate', () => {
  it('refuses read and crawler API keys without even verifying them', async () => {
    for (const key of ['fgr_abc', 'fgc_abc']) {
      const res = await rpc('tools/list', {}, key).expect(401);
      expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
    }
    expect(verifyEntraAccessToken).not.toHaveBeenCalled();
  });

  it('verifies against the MCP resource URL, the api:// URI and the bare client id — nothing else', async () => {
    verifyEntraAccessToken.mockResolvedValue(claims(['Admin']));
    await rpc('tools/list').expect(200);
    expect(verifyEntraAccessToken).toHaveBeenCalledWith('tok', [`${BASE}/mcp`, 'api://client-1', 'client-1']);
  });

  it('answers an invalid token with 401 invalid_token', async () => {
    verifyEntraAccessToken.mockRejectedValue(new Error('jwt expired'));
    const res = await rpc('tools/list').expect(401);
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
  });

  it('refuses a valid token without the Mcp.Read scope (e.g. the web app\'s own token) with 403 insufficient_scope', async () => {
    for (const scp of ['access', null, 'Mcp.ReadAll']) {
      verifyEntraAccessToken.mockResolvedValue(claims(['Admin'], scp));
      const res = await rpc('tools/list').expect(403);
      expect(res.headers['www-authenticate']).toContain('error="insufficient_scope"');
    }
  });

  it('accepts the scope among others', async () => {
    verifyEntraAccessToken.mockResolvedValue(claims(['Admin'], 'access Mcp.Read'));
    await rpc('tools/list').expect(200);
  });

  it('refuses a user whose roles lack mcp.use, whatever else they may read', async () => {
    verifyEntraAccessToken.mockResolvedValue(claims(['NoMcp']));
    const res = await rpc('tools/list').expect(403);
    expect(res.body.required).toEqual(['mcp.use']);
  });
});

describe('tools follow the caller\'s permissions', () => {
  const toolNames = async (role) => {
    verifyEntraAccessToken.mockResolvedValue(claims([role]));
    const res = await rpc('tools/list').expect(200);
    return res.body.result.tools.map(t => t.name).sort();
  };

  it('lists everything for an admin, with server instructions on initialize', async () => {
    expect(await toolNames('Admin')).toEqual(['describe_data_model', 'list_reports', 'run_query', 'run_report', 'search', 'whoami']);
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }).expect(200);
    expect(init.body.result.serverInfo).toMatchObject({ name: 'identity-atlas', version: '9.9.9' });
    expect(init.body.result.instructions).toContain('read-only');
  });

  it('hides the query tools from a role that may read but not ask', async () => {
    expect(await toolNames('Reader')).toEqual(['list_reports', 'run_report', 'search', 'whoami']);
    expect(await toolNames('Asker')).toEqual(['describe_data_model', 'list_reports', 'run_query', 'run_report', 'search', 'whoami']);
  });

  it('marks every tool read-only', async () => {
    verifyEntraAccessToken.mockResolvedValue(claims(['Admin']));
    const res = await rpc('tools/list').expect(200);
    for (const t of res.body.result.tools) expect(t.annotations.readOnlyHint).toBe(true);
  });

  it('refuses — and logs — a call to a tool the role does not have, without running it', async () => {
    verifyEntraAccessToken.mockResolvedValue(claims(['Reader']));
    const res = await rpc('tools/call', { name: 'run_query', arguments: { definition: { entity: 'user' } } }).expect(200);
    expect(res.body.result.isError).toBe(true);
    const audit = query.mock.calls.find(([sql]) => sql.includes('"McpToolCalls"'));
    expect(audit[1][3]).toBe('run_query');
    expect(audit[1][5]).toBe('refused');
  });
});

describe('run_report end to end', () => {
  it('runs the report with the caller\'s parameters, caps the rows, links them and logs the call', async () => {
    verifyEntraAccessToken.mockResolvedValue(claims(['Reader']));
    const res = await rpc('tools/call', { name: 'run_report', arguments: { name: 'mcp-test-report', parameters: { prefix: 'p' }, maxRows: 3 } }).expect(200);
    const out = res.body.result.structuredContent;
    expect(out.report).toBe('MCP test report');
    expect(out.total).toBe(7);
    expect(out.rowCount).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.notices).toEqual(['computed for the test']);
    expect(out.rows[0]).toEqual({ displayName: 'p-0', link: `${BASE}/#user:u0` });
    expect(JSON.parse(res.body.result.content[0].text)).toEqual(out);

    const audit = query.mock.calls.find(([sql]) => sql.includes('"McpToolCalls"'))[1];
    expect(audit.slice(0, 7)).toEqual([
      '11111111-1111-1111-1111-111111111111', 'ada@example.com', 'Claude-User', 'run_report',
      JSON.stringify({ name: 'mcp-test-report', parameters: { prefix: 'p' }, maxRows: 3 }), 'ok', 3,
    ]);
  });
});

describe('methods other than POST', () => {
  it('answers GET and DELETE with 405', async () => {
    await request(app).get('/mcp').expect(405);
    await request(app).delete('/mcp').expect(405);
  });
});
