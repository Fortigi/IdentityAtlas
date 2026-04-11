// Identity Atlas v5 — Risk profile + classifier API.
//
// This is the workhorse route for the new "Risk Profile wizard" UI. It handles:
//   - URL scraping (POST /risk-profiles/scrape)
//   - Initial profile generation (POST /risk-profiles/generate)
//   - Conversational refinement (POST /risk-profiles/refine)
//   - Saving / listing / activating (CRUD on RiskProfiles)
//   - Classifier generation (POST /risk-classifiers/generate)
//   - Classifier CRUD on RiskClassifiers
//
// Generation endpoints don't write to the database — they just return a draft
// the UI can show to the user. Save endpoints persist the final draft. This
// keeps the wizard's "discard" path trivial (no rows to delete) and means a
// half-finished refinement doesn't pollute history.

import { Router } from 'express';
import * as db from '../db/connection.js';
import { chatWithSavedConfig, isLLMConfigured, getLLMConfig } from '../llm/service.js';
import { scrapeAll, buildLLMContextFromScrapes } from '../llm/scraper.js';
import {
  profileGenerationPrompt,
  profileRefinementPrompt,
  classifierGenerationPrompt,
  extractJson,
} from '../llm/riskPrompts.js';
import { putSecret, getSecret, deleteSecret } from '../secrets/vault.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

// Guard: every LLM-using endpoint should reject early when nothing is configured
async function requireLLM(res) {
  const ok = await isLLMConfigured();
  if (!ok) {
    res.status(412).json({ error: 'No LLM provider configured. Set one in Admin → LLM Settings.' });
    return false;
  }
  return true;
}

// ─── URL scraping with optional credentials ────────────────────────
//
// Body: { urls: [{ url, credentialId? }, ...] }
// credentialId is the id of a Secret in the 'scraper' scope. The route loads
// and decrypts each one, hands the plaintext to the scraper, and discards it
// after the call. The scraper itself never touches the database.
router.post('/risk-profiles/scrape', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const { urls } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls must be a non-empty array' });
  }
  if (urls.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 URLs per scrape request' });
  }

  try {
    // Resolve credentials per URL (one DB round-trip per credentialId)
    const targets = [];
    for (const u of urls) {
      if (typeof u !== 'object' || !u.url) continue;
      let credentials = null;
      if (u.credentialId) {
        const secret = await getSecret(u.credentialId);
        if (secret) {
          // Stored as JSON: {username,password} or {bearer}
          try { credentials = JSON.parse(secret); }
          catch { credentials = { bearer: secret }; }
        }
      } else if (u.credentials) {
        // Inline (one-off, never persisted)
        credentials = u.credentials;
      }
      targets.push({ url: u.url, credentials });
    }
    const results = await scrapeAll(targets);
    // Strip the actual text from the response by default — it can be huge.
    // The caller can re-request with includeText=true if they want a preview.
    const includeText = req.query.includeText === 'true';
    const summary = results.map(r => includeText ? r : ({ ...r, text: undefined }));
    res.json({ results: summary, count: summary.length });
  } catch (err) {
    console.error('scrape failed:', err.message);
    res.status(500).json({ error: 'Scrape failed', message: err.message });
  }
});

// ─── Generate an initial profile draft (no DB write) ───────────────
//
// Body: { domain, organizationName?, hints?, urls?: [{url, credentialId?}, ...] }
// Returns { profile, scraped: [...status], llmModel }
router.post('/risk-profiles/generate', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  if (!(await requireLLM(res))) return;
  const { domain, organizationName, hints, urls } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain is required' });

  try {
    // Optional URL scrape phase. Same credential resolution as /scrape.
    let scrapedContext = '';
    let scrapedSummary = [];
    if (Array.isArray(urls) && urls.length > 0) {
      const targets = [];
      for (const u of urls) {
        if (!u || !u.url) continue;
        let credentials = null;
        if (u.credentialId) {
          const secret = await getSecret(u.credentialId);
          if (secret) { try { credentials = JSON.parse(secret); } catch { credentials = { bearer: secret }; } }
        }
        targets.push({ url: u.url, credentials });
      }
      const results = await scrapeAll(targets);
      scrapedContext = buildLLMContextFromScrapes(results);
      scrapedSummary = results.map(r => ({ url: r.url, ok: r.ok, status: r.status, bytes: r.bytes, error: r.error }));
    }

    const { system, messages } = profileGenerationPrompt({ domain, organizationName, hints, scrapedContext });
    // 8192 tokens — full profile responses for large organisations (15+ critical
    // roles, 10+ known systems, multiple regulations) routinely exceed 4k tokens,
    // causing truncation and "non-JSON" parse failures on the closing brace.
    const llmResp = await chatWithSavedConfig({ system, messages, temperature: 0.3, maxTokens: 8192 });
    const parsed = extractJson(llmResp.text);
    if (!parsed) {
      console.error('Profile generation: LLM returned non-JSON. Raw:', llmResp.text.slice(0, 500));
      // Detect the most common cause (truncation) and give a useful hint.
      // If the response ends without a closing brace, the LLM hit the token cap.
      const tail = llmResp.text.trim().slice(-50);
      const looksTruncated = !tail.endsWith('}') && tail.length > 20;
      const usage = llmResp.usage;
      const hitCap = usage && usage.outputTokens && usage.outputTokens >= 8000;
      const isTruncation = looksTruncated || hitCap;
      const errorMsg = isTruncation
        ? `The LLM response was truncated at ${usage?.outputTokens ?? '?'} output tokens. This usually means the profile is too large for the current token budget. Try again, or switch to a smaller model in Admin → LLM Settings.`
        : 'LLM returned a malformed JSON response. Try again — or check the server logs for the parse error.';
      return res.status(502).json({
        error: errorMsg,
        truncated: isTruncation,
        outputTokens: usage?.outputTokens ?? null,
        raw: llmResp.text.slice(0, 1000),
      });
    }
    const profile = parsed.customer_profile || parsed;

    res.json({
      profile,
      scraped: scrapedSummary,
      llmModel: llmResp.model,
      usage: llmResp.usage,
    });
  } catch (err) {
    console.error('profile generate failed:', err.message);
    res.status(500).json({ error: 'Profile generation failed', message: err.message });
  }
});

// ─── Refine an existing draft via chat (no DB write) ───────────────
//
// Body: { profile, transcript: [{role, content}], userMessage }
// Returns { profile (updated), assistantMessage: '[updated profile applied]' }
router.post('/risk-profiles/refine', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  if (!(await requireLLM(res))) return;
  const { profile, transcript, userMessage } = req.body || {};
  if (!profile)     return res.status(400).json({ error: 'profile is required' });
  if (!userMessage) return res.status(400).json({ error: 'userMessage is required' });

  try {
    const { system, messages } = profileRefinementPrompt({ currentProfile: profile, transcript, userMessage });
    const llmResp = await chatWithSavedConfig({ system, messages, temperature: 0.3, maxTokens: 8192 });
    const parsed = extractJson(llmResp.text);

    // Primary path: the new prompt asks for { assistantMessage, profile, profileChanged }
    // Fallback: if the LLM forgot the wrapper and returned just a profile JSON,
    // treat the whole thing as a profile update with a generic message.
    // Last resort: if we can't parse anything structured, return the raw text as
    // an assistant message without a profile change — the user still gets a reply.
    let assistantMessage = null;
    let updatedProfile = null;
    let profileChanged = false;

    if (parsed && parsed.assistantMessage && parsed.profile) {
      assistantMessage = parsed.assistantMessage;
      updatedProfile = parsed.profile.customer_profile || parsed.profile;
      profileChanged = parsed.profileChanged !== false;
    } else if (parsed) {
      // Unwrapped profile response (old-style)
      updatedProfile = parsed.customer_profile || parsed;
      assistantMessage = '(profile updated)';
      profileChanged = true;
    } else {
      // Couldn't parse JSON at all — return the raw text as a chat message.
      // The profile stays unchanged. This way the user sees the LLM's answer
      // instead of a cryptic "non-JSON response" error.
      assistantMessage = llmResp.text.trim().slice(0, 2000);
      updatedProfile = profile; // unchanged
      profileChanged = false;
    }

    res.json({
      profile: updatedProfile,
      profileChanged,
      assistantMessage,
      llmModel: llmResp.model,
      usage: llmResp.usage,
    });
  } catch (err) {
    console.error('profile refine failed:', err.message);
    res.status(500).json({ error: 'Profile refinement failed', message: err.message });
  }
});

// ─── Save profile (creates a new version row) ─────────────────────
//
// Body: { displayName, profile, transcript?, sources?, makeActive? }
router.post('/risk-profiles', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const { displayName, profile, transcript, sources, makeActive } = req.body || {};
  if (!displayName) return res.status(400).json({ error: 'displayName is required' });
  if (!profile)     return res.status(400).json({ error: 'profile is required' });

  try {
    const llmCfg = await getLLMConfig().catch(() => null);
    // Determine the next version number for this displayName
    const versionRow = await db.queryOne(
      `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM "RiskProfiles" WHERE "displayName" = $1`,
      [displayName]
    );
    const version = versionRow?.v || 1;
    const createdBy = req.user?.preferred_username || req.user?.name || 'system';

    const ins = await db.queryOne(
      `INSERT INTO "RiskProfiles"
         ("displayName", domain, industry, country, profile, transcript, sources,
          "llmProvider", "llmModel", version, "isActive", "createdBy", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
       RETURNING id, version, "createdAt"`,
      [
        displayName,
        profile?.domain   || null,
        profile?.industry || null,
        profile?.country  || null,
        JSON.stringify(profile),
        transcript ? JSON.stringify(transcript) : null,
        sources    ? JSON.stringify(sources)    : null,
        llmCfg?.provider || null,
        llmCfg?.model    || null,
        version,
        !!makeActive,
        createdBy,
      ]
    );
    res.status(201).json({ id: ins.id, version: ins.version, createdAt: ins.createdAt, isActive: !!makeActive });
  } catch (err) {
    console.error('profile save failed:', err.message);
    res.status(500).json({ error: 'Save failed', message: err.message });
  }
});

// ─── List saved profiles ──────────────────────────────────────────
router.get('/risk-profiles', async (_req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  try {
    const r = await db.query(
      `SELECT id, "displayName", domain, industry, country, "llmProvider", "llmModel",
              version, "isActive", "createdBy", "createdAt", "updatedAt"
         FROM "RiskProfiles"
        ORDER BY "isActive" DESC, "createdAt" DESC`
    );
    res.json({ data: r.rows, total: r.rows.length });
  } catch (err) {
    console.error('profile list failed:', err.message);
    res.status(500).json({ error: 'List failed' });
  }
});

// ─── Scraper credential CRUD — MUST come before /:id routes so the literal
// path doesn't match the parameter route.
router.get('/risk-profiles/scraper-credentials', async (_req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  try {
    const r = await db.query(
      `SELECT id, label, "createdAt" FROM "Secrets" WHERE scope = 'scraper' ORDER BY id`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'List failed' });
  }
});

router.post('/risk-profiles/scraper-credentials', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const { label, username, password, bearer } = req.body || {};
  if (!label) return res.status(400).json({ error: 'label is required' });
  if (!username && !bearer) return res.status(400).json({ error: 'username/password or bearer is required' });
  try {
    const id = `scraper.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
    const value = bearer ? JSON.stringify({ bearer }) : JSON.stringify({ username, password: password || '' });
    await putSecret(id, 'scraper', value, label);
    res.status(201).json({ id, label });
  } catch (err) {
    console.error('scraper-credential create failed:', err.message);
    res.status(500).json({ error: 'Create failed' });
  }
});

router.delete('/risk-profiles/scraper-credentials/:id', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  try {
    await deleteSecret(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ─── Get one profile (full body) ──────────────────────────────────
router.get('/risk-profiles/:id', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await db.queryOne(`SELECT * FROM "RiskProfiles" WHERE id = $1`, [id]);
    if (!r) return res.status(404).json({ error: 'Not found' });
    res.json(r);
  } catch (err) {
    console.error('profile get failed:', err.message);
    res.status(500).json({ error: 'Get failed' });
  }
});

// ─── Activate a profile (the trigger ensures uniqueness) ──────────
router.post('/risk-profiles/:id/activate', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await db.queryOne(
      `UPDATE "RiskProfiles" SET "isActive" = true, "updatedAt" = now() WHERE id = $1 RETURNING id`,
      [id]
    );
    if (!r) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('profile activate failed:', err.message);
    res.status(500).json({ error: 'Activate failed' });
  }
});

router.delete('/risk-profiles/:id', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    await db.query(`DELETE FROM "RiskProfiles" WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('profile delete failed:', err.message);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ─── Classifiers ──────────────────────────────────────────────────

// Generate from a saved profile (no DB write)
router.post('/risk-classifiers/generate', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  if (!(await requireLLM(res))) return;
  const { profileId } = req.body || {};
  if (!profileId) return res.status(400).json({ error: 'profileId is required' });
  try {
    const prof = await db.queryOne(`SELECT * FROM "RiskProfiles" WHERE id = $1`, [profileId]);
    if (!prof) return res.status(404).json({ error: 'Profile not found' });
    const { system, messages } = classifierGenerationPrompt({ profile: prof.profile });
    // 16384 tokens — classifier sets for large orgs produce many regex patterns
    // per category (groups + users + agents). Profiles with 10+ regulations and
    // 15+ critical roles routinely push past 8k output tokens. Claude Opus/Sonnet
    // support up to 32k output, so 16k is a safe headroom without hitting the cap.
    const llmResp = await chatWithSavedConfig({ system, messages, temperature: 0.2, maxTokens: 16384 });
    const parsed = extractJson(llmResp.text);
    if (!parsed) {
      console.error('Classifier generation: LLM returned non-JSON. Raw:', llmResp.text.slice(0, 500));
      const tail = llmResp.text.trim().slice(-50);
      const looksTruncated = !tail.endsWith('}') && tail.length > 20;
      const usage = llmResp.usage;
      const hitCap = usage && usage.outputTokens && usage.outputTokens >= 8000;
      const isTruncation = looksTruncated || hitCap;
      const errorMsg = isTruncation
        ? `The LLM response was truncated at ${usage?.outputTokens ?? '?'} output tokens. The classifier set is too large for the current token budget. Try again, or switch to a smaller/faster model in Admin → LLM Settings.`
        : 'LLM returned a malformed JSON response. Try again — or check the server logs for the parse error.';
      return res.status(502).json({
        error: errorMsg,
        truncated: isTruncation,
        outputTokens: usage?.outputTokens ?? null,
        raw: llmResp.text.slice(0, 1000),
      });
    }
    res.json({ classifiers: parsed, llmModel: llmResp.model, usage: llmResp.usage });
  } catch (err) {
    console.error('classifier generate failed:', err.message);
    res.status(500).json({ error: 'Generation failed', message: err.message });
  }
});

// Save a classifier set
router.post('/risk-classifiers', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const { displayName, profileId, classifiers, makeActive } = req.body || {};
  if (!displayName) return res.status(400).json({ error: 'displayName is required' });
  if (!classifiers) return res.status(400).json({ error: 'classifiers is required' });
  try {
    const llmCfg = await getLLMConfig().catch(() => null);
    const versionRow = await db.queryOne(
      `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM "RiskClassifiers" WHERE "displayName" = $1`,
      [displayName]
    );
    const createdBy = req.user?.preferred_username || req.user?.name || 'system';
    const ins = await db.queryOne(
      `INSERT INTO "RiskClassifiers"
         ("profileId","displayName",classifiers,"llmProvider","llmModel",version,"isActive","createdBy","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
       RETURNING id, version, "createdAt"`,
      [
        profileId || null,
        displayName,
        JSON.stringify(classifiers),
        llmCfg?.provider || null,
        llmCfg?.model    || null,
        versionRow?.v || 1,
        !!makeActive,
        createdBy,
      ]
    );
    res.status(201).json({ id: ins.id, version: ins.version, createdAt: ins.createdAt });
  } catch (err) {
    console.error('classifier save failed:', err.message);
    res.status(500).json({ error: 'Save failed', message: err.message });
  }
});

router.get('/risk-classifiers', async (_req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  try {
    const r = await db.query(
      `SELECT id, "profileId", "displayName", "llmProvider", "llmModel", version, "isActive",
              "createdBy", "createdAt", "updatedAt"
         FROM "RiskClassifiers"
        ORDER BY "isActive" DESC, "createdAt" DESC`
    );
    res.json({ data: r.rows, total: r.rows.length });
  } catch (err) {
    console.error('classifier list failed:', err.message);
    res.status(500).json({ error: 'List failed' });
  }
});

router.get('/risk-classifiers/:id', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await db.queryOne(`SELECT * FROM "RiskClassifiers" WHERE id = $1`, [id]);
    if (!r) return res.status(404).json({ error: 'Not found' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: 'Get failed' });
  }
});

router.post('/risk-classifiers/:id/activate', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const r = await db.queryOne(
      `UPDATE "RiskClassifiers" SET "isActive" = true, "updatedAt" = now() WHERE id = $1 RETURNING id`,
      [id]
    );
    if (!r) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: 'Activate failed' });
  }
});

router.delete('/risk-classifiers/:id', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    await db.query(`DELETE FROM "RiskClassifiers" WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

export default router;
