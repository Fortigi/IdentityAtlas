// Shared helpers for routes/riskProfiles.js, extracted to keep the scrape /
// generate / save handlers under the complexity threshold. resolveScrapeTargets
// + buildLlmJsonError were also duplicated with the classifier path. In a
// subdirectory so the OpenAPI router-drift guard doesn't scan it.

import { getSecret } from '../../secrets/vault.js';
import { compilePattern } from '../../riskscoring/engine.js';

// Resolve each URL's optional stored/inline credentials into scrape targets.
// One getSecret round-trip per credentialId; a non-JSON secret is treated as a
// bearer token. Shared by /scrape and /generate.
export async function resolveScrapeTargets(urls) {
  const targets = [];
  for (const u of urls) {
    if (!u || typeof u !== 'object' || !u.url) continue;
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
  return targets;
}

// Build the 502 body for an LLM response we couldn't parse as JSON. Detects the
// common cause (truncation: no closing brace, or output tokens near the cap) and
// returns a useful message. `tooLargeMsg(outputTokens)` supplies the
// context-specific "too large" text (profile vs classifier set).
export function buildLlmJsonError(llmResp, tooLargeMsg) {
  const tail = llmResp.text.trim().slice(-50);
  const looksTruncated = !tail.endsWith('}') && tail.length > 20;
  const usage = llmResp.usage;
  const hitCap = usage && usage.outputTokens && usage.outputTokens >= 8000;
  const isTruncation = looksTruncated || hitCap;
  const error = isTruncation
    ? tooLargeMsg(usage?.outputTokens ?? '?')
    : 'LLM returned a malformed JSON response. Try again — or check the server logs for the parse error.';
  return {
    error,
    truncated: isTruncation,
    outputTokens: usage?.outputTokens ?? null,
    raw: llmResp.text.slice(0, 1000),
  };
}

// Bound params for the RiskProfiles INSERT (the many `profile?.x || null`
// fallbacks were most of the save handler's cyclomatic complexity).
export function buildProfileInsertParams({ displayName, profile, transcript, sources, llmCfg, version, makeActive, createdBy }) {
  return [
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
  ];
}

// Validate every classifier regex with the same RE2 engine the scorer uses, so
// an invalid / unsupported pattern is rejected at save time (M-6).
export function findInvalidClassifierPatterns(classifiers) {
  const bad = [];
  for (const group of ['groupClassifiers', 'userClassifiers', 'agentClassifiers']) {
    for (const c of (classifiers?.[group] || [])) {
      for (const p of (c?.patterns || [])) {
        if (typeof p !== 'string' || !p.trim()) continue;
        try { compilePattern(p); }
        catch (err) { bad.push({ classifier: c.id || c.label || '(unnamed)', pattern: p, reason: err.message }); }
      }
    }
  }
  return bad;
}
