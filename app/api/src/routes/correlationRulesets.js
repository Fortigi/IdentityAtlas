// Identity Atlas v5 — Account Correlation Ruleset API.
//
// Handles generation, refinement, and persistence of correlation rulesets.
// Mirrors the riskProfiles.js pattern but for account correlation rules.

import { Router } from 'express';
import * as db from '../db/connection.js';
import { chatWithSavedConfig, isLLMConfigured } from '../llm/service.js';
import {
  correlationRulesetGenerationPrompt,
  correlationRulesetRefinementPrompt,
  extractJson,
} from '../llm/correlationPrompts.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

// Guard: require LLM configuration
async function requireLLM(res) {
  const ok = await isLLMConfigured();
  if (!ok) {
    res.status(412).json({ error: 'No LLM provider configured. Set one in Admin → LLM Settings.' });
    return false;
  }
  return true;
}

// ─── Generate an initial correlation ruleset draft (no DB write) ──
//
// Body: { domain, organizationName?, hints?, systems?: [] }
// Returns { ruleset, llmModel, usage }
router.post('/correlation-rulesets/generate', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  if (!(await requireLLM(res))) return;

  const { domain, organizationName, hints, systems } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain is required' });

  try {
    const { system, messages } = correlationRulesetGenerationPrompt({
      domain,
      organizationName,
      hints,
      systems,
    });

    const llmResp = await chatWithSavedConfig({
      system,
      messages,
      temperature: 0.3,
      maxTokens: 4096,
    });

    const parsed = extractJson(llmResp.text);
    if (!parsed) {
      console.error('Correlation ruleset generation: LLM returned non-JSON. Raw:', llmResp.text.slice(0, 500));
      const tail = llmResp.text.trim().slice(-50);
      const looksTruncated = !tail.endsWith('}') && tail.length > 20;
      const usage = llmResp.usage;
      const hitCap = usage && usage.outputTokens && usage.outputTokens >= 3900;
      const isTruncation = looksTruncated || hitCap;
      const errorMsg = isTruncation
        ? `The LLM response was truncated at ${usage?.outputTokens ?? '?'} output tokens. Try again with a shorter hint, or switch models.`
        : 'LLM returned a malformed JSON response. Try again — or check the server logs.';
      return res.status(502).json({
        error: errorMsg,
        truncated: isTruncation,
        outputTokens: usage?.outputTokens ?? null,
        raw: llmResp.text.slice(0, 1000),
      });
    }

    const ruleset = parsed.correlation_ruleset || parsed;

    res.json({
      ruleset,
      llmModel: llmResp.model,
      usage: llmResp.usage,
    });
  } catch (err) {
    console.error('correlation ruleset generate failed:', err.message);
    res.status(500).json({ error: 'Ruleset generation failed', message: err.message });
  }
});

// ─── Refine an existing draft via chat (no DB write) ──────────────
//
// Body: { ruleset, transcript: [{role, content}], userMessage }
// Returns { ruleset (updated), assistantMessage }
router.post('/correlation-rulesets/refine', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  if (!(await requireLLM(res))) return;

  const { ruleset, transcript, userMessage } = req.body || {};
  if (!ruleset) return res.status(400).json({ error: 'ruleset is required' });
  if (!userMessage) return res.status(400).json({ error: 'userMessage is required' });

  try {
    const { system, messages } = correlationRulesetRefinementPrompt({
      currentRuleset: ruleset,
      transcript,
      userMessage,
    });

    const llmResp = await chatWithSavedConfig({
      system,
      messages,
      temperature: 0.3,
      maxTokens: 4096,
    });

    const parsed = extractJson(llmResp.text);

    let assistantMessage = null;
    let updatedRuleset = null;
    let rulesetChanged = false;

    if (parsed && parsed.assistantMessage && parsed.ruleset) {
      assistantMessage = parsed.assistantMessage;
      updatedRuleset = parsed.ruleset.correlation_ruleset || parsed.ruleset;
      rulesetChanged = parsed.rulesetChanged !== false;
    } else if (parsed) {
      // Unwrapped ruleset response (old-style)
      updatedRuleset = parsed.correlation_ruleset || parsed;
      assistantMessage = '(ruleset updated)';
      rulesetChanged = true;
    } else {
      // Couldn't parse JSON — return raw text as chat message
      assistantMessage = llmResp.text.trim().slice(0, 2000);
      updatedRuleset = ruleset; // unchanged
      rulesetChanged = false;
    }

    res.json({
      ruleset: updatedRuleset,
      assistantMessage,
      rulesetChanged,
      llmModel: llmResp.model,
      usage: llmResp.usage,
    });
  } catch (err) {
    console.error('correlation ruleset refine failed:', err.message);
    res.status(500).json({ error: 'Refinement failed', message: err.message });
  }
});

// ─── Save a ruleset to the database ────────────────────────────────
//
// Body: { ruleset, version?, makeActive? }
// Returns { id, version, generatedAt }
router.post('/correlation-rulesets', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });

  const { ruleset, version, makeActive } = req.body || {};
  if (!ruleset) return res.status(400).json({ error: 'ruleset is required' });

  try {
    const pool = await db.getPool();
    // Generate a simple ID using timestamp + random suffix
    const id = `correlation.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
    const versionLabel = version || '1.0';
    const generatedAt = new Date().toISOString();

    // Ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "GraphCorrelationRulesets" (
        "id"          TEXT PRIMARY KEY,
        "rulesetJson" JSONB NOT NULL,
        "version"     TEXT,
        "generatedAt" TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
      );
    `);

    // Insert the new ruleset
    await pool.query({
      text: `
        INSERT INTO "GraphCorrelationRulesets" ("id", "rulesetJson", "version", "generatedAt")
        VALUES ($1, $2, $3, $4)
      `,
      values: [id, JSON.stringify(ruleset), versionLabel, generatedAt],
    });

    res.json({
      id,
      version: versionLabel,
      generatedAt,
      message: 'Correlation ruleset saved',
    });
  } catch (err) {
    console.error('save correlation ruleset failed:', err.message);
    res.status(500).json({ error: 'Failed to save ruleset', message: err.message });
  }
});

// ─── List all saved rulesets ───────────────────────────────────────
router.get('/correlation-rulesets', async (req, res) => {
  if (!useSql) return res.json([]);

  try {
    const pool = await db.getPool();

    // Check if table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM pg_tables
        WHERE schemaname = 'public'
        AND tablename = 'GraphCorrelationRulesets'
      )
    `);

    if (!tableCheck.rows[0].exists) {
      return res.json([]);
    }

    const result = await pool.query(`
      SELECT "id", "version", "generatedAt"
      FROM "GraphCorrelationRulesets"
      ORDER BY "generatedAt" DESC
    `);

    res.json(result.rows.map(r => ({
      id: r.id,
      version: r.version,
      generatedAt: r.generatedAt,
    })));
  } catch (err) {
    console.error('list correlation rulesets failed:', err.message);
    res.status(500).json({ error: 'Failed to list rulesets' });
  }
});

// ─── Get a specific ruleset ────────────────────────────────────────
router.get('/correlation-rulesets/:id', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });

  try {
    const pool = await db.getPool();
    const { id } = req.params;

    const result = await pool.query({
      text: `SELECT "id", "rulesetJson", "version", "generatedAt" FROM "GraphCorrelationRulesets" WHERE "id" = $1`,
      values: [id],
    });

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ruleset not found' });
    }

    const row = result.rows[0];
    res.json({
      id: row.id,
      ruleset: row.rulesetJson,
      version: row.version,
      generatedAt: row.generatedAt,
    });
  } catch (err) {
    console.error('get correlation ruleset failed:', err.message);
    res.status(500).json({ error: 'Failed to load ruleset' });
  }
});

export default router;
