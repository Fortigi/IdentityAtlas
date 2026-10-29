// The MCP endpoint (Streamable HTTP, stateless) and its OAuth discovery document.
//
//   GET  /.well-known/oauth-protected-resource[/mcp]  where to sign in (RFC 9728)
//   POST /mcp                                          JSON-RPC: initialize, tools/list, tools/call
//   GET / DELETE /mcp                                  405 — no server-initiated streams, no sessions
//
// All of it answers 404 unless sign-in is on and the mcpServer feature is
// switched on (mcp/auth.js). Lives outside /api: MCP clients are configured
// with one URL, and `<host>/mcp` is the one people will type.

import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { resolvePublicBaseUrl } from '../export/exportBaseUrl.js';
import { mcpAuth, mcpAvailable } from './auth.js';
import { MCP_PATH, METADATA_PATH, protectedResourceMetadata } from './resource.js';
import { createMcpServer } from './server.js';
import { lazyCaller } from './tools/query.js';

export function createMcpRouter({ limiter = (_req, _res, next) => next(), version } = {}) {
  const router = Router();

  router.get([METADATA_PATH, `${METADATA_PATH}${MCP_PATH}`], mcpAvailable, (req, res) => {
    res.json(protectedResourceMetadata(req));
  });

  router.post(MCP_PATH, mcpAvailable, mcpAuth, limiter, async (req, res) => {
    const ctx = {
      user: req.user,
      baseUrl: resolvePublicBaseUrl(req),
      client: req.get('user-agent') || null,
      caller: lazyCaller(req.user?.oid),
    };
    const server = createMcpServer(ctx, { version });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request failed:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    }
  });

  router.all(MCP_PATH, mcpAvailable, (_req, res) => {
    res.set('Allow', 'POST');
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  });

  return router;
}
