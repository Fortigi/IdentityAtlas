// Admin view of the MCP server (Admin → Experimental → MCP server card).
//
// GET /api/admin/mcp  — the endpoint URL to give an AI client, the scope it asks
//                       for, and the most recent tool calls from the audit log.
// Needs admin.feature-flags: the same admins who switch the feature on see what
// it is used for. Arguments in the log can hold names people asked about.

import { Router } from 'express';
import { requirePermission } from '../../middleware/auth.js';
import { listToolCalls } from '../../mcp/audit.js';
import { mcpResourceUrl, scopeFor } from '../../mcp/resource.js';

const router = Router();

router.get('/admin/mcp', requirePermission('admin.feature-flags'), async (req, res) => {
  try {
    const url = mcpResourceUrl(req);
    res.json({ url, scope: scopeFor(url), calls: await listToolCalls({ limit: req.query.limit }) });
  } catch (err) {
    console.error('GET /admin/mcp failed:', err.message);
    res.status(500).json({ error: 'Failed to read the MCP log' });
  }
});

export default router;
