// Identity Atlas v5 — risk-profile + classifier prompts.
//
// Centralised here so the route handlers stay thin and the prompts are easy to
// audit. Each function returns `{ system, messages }` ready to pass to
// `chatWithSavedConfig()`. JSON-schema-shaped prompts include explicit
// "ONLY a valid JSON object" instructions because providers vary in how often
// they wrap responses in markdown fences.
//
// The prompts are deliberately verbose. LLMs (especially smaller models)
// produce noticeably better structured output when the schema is spelled out
// inline rather than referenced. Token cost is dwarfed by the cost of having
// to retry on malformed JSON.

// ────────────────────────────────────────────────────────────────────
// Step 1 — initial profile generation
// ────────────────────────────────────────────────────────────────────
//
// Inputs that the user typed: domain (required), org name (optional), free-text
// hints (optional), plus the scraped text from any URLs they added.

export function profileGenerationPrompt({ domain, organizationName, hints, scrapedContext }) {
  const system = `You are an identity security consultant specialising in organisational risk profiling for identity governance.

Your task is to research an organisation based on its public domain name (and any context the user supplies) and generate a structured risk profile. This profile will later be used to generate identity risk classifiers — regex patterns that detect high-risk groups, users, and applications in their Active Directory / Entra ID environment.

IMPORTANT: You are ONLY generating a profile of public organisational context. No actual identity data (user names, group names, etc.) will be shared with you.

You must respond with ONLY a valid JSON object (no markdown fencing, no explanation before or after). The JSON must follow this exact schema:

{
  "customer_profile": {
    "name": "Full legal name of organisation",
    "domain": "domain.com",
    "industry": "industry-slug",
    "sub_industry": "sub-industry-slug",
    "country": "ISO country code",
    "description": "One paragraph description of what the organisation does",
    "regulations": [
      { "id": "regulation-slug", "name": "Full regulation name", "relevance": "Why this regulation applies" }
    ],
    "critical_business_processes": ["Process description"],
    "known_systems": [
      { "name": "System name", "type": "type/description", "criticality": "critical|high|medium", "description": "What it does" }
    ],
    "critical_roles": [
      { "title_patterns": ["regex pattern1", "pattern2"], "rationale": "Why critical" }
    ],
    "risk_domains": [
      { "domain": "domain-slug", "description": "What this risk domain covers", "weight": 0.0 }
    ]
  }
}

Research targets:
- What does the organisation do? (industry, sector, sub-sector)
- What regulations apply? (NIS2, DORA, SOX, HIPAA, Wbni, BIO, etc.)
- What are their critical business processes?
- What key systems/platforms are publicly known?
- What security frameworks do they likely follow? (ISO 27001, NIST, BIO for government)
- What are typical critical roles/titles in this industry? Include BOTH English and local-language variants in the regex patterns.
- What are the main risk domains for this organisation?

For title patterns, use regex that works case-insensitively. Be specific to THIS organisation, not generic.`;

  const userParts = [];
  userParts.push(`Research the organisation at domain "${domain}".`);
  if (organizationName) userParts.push(`The organisation is also known as "${organizationName}".`);
  if (hints)            userParts.push(`User-supplied context: ${hints}`);
  if (scrapedContext)   userParts.push(`The user has provided the following text from internal/public sources:\n\n${scrapedContext}`);
  userParts.push(`\nGenerate the customer_profile JSON object as specified.`);

  return {
    system,
    messages: [{ role: 'user', content: userParts.join('\n\n') }],
  };
}

// ────────────────────────────────────────────────────────────────────
// Step 1b — conversational refinement
// ────────────────────────────────────────────────────────────────────
//
// The chat UI lets the user iterate ("we don't actually use SAP", "include the
// medical-device division", "drop NIS2, we're a US-only entity"). Each refine
// turn sends the current profile + the full conversation history + the new
// user message. The model returns a *replacement* JSON object — the route
// handler stores both the new profile and appends the message pair to the
// transcript.

export function profileRefinementPrompt({ currentProfile, transcript, userMessage }) {
  const system = `You are an identity security consultant helping refine a customer's organisational risk profile.

The user has an existing profile (provided below as JSON) and wants to adjust it based on the conversation. Your job is to apply the user's feedback and respond with the COMPLETE updated profile JSON.

You must respond with ONLY a valid JSON object — the same schema as the existing profile. No markdown fencing, no commentary outside the JSON. If the user is asking a question rather than requesting a change, embed your answer as a "description" or in an existing field rather than producing prose.

CURRENT PROFILE:
${JSON.stringify(currentProfile, null, 2)}`;

  // Replay the conversation history so the model has context about earlier
  // refinements. We don't include the model's previous JSON dumps verbatim —
  // they're the same structure as the current profile and would just bloat the
  // context. Instead, summarise as "[updated profile]".
  const messages = [];
  for (const turn of (transcript || [])) {
    if (turn.role === 'user')      messages.push({ role: 'user',      content: turn.content });
    else if (turn.role === 'assistant') messages.push({ role: 'assistant', content: '[updated profile applied]' });
  }
  messages.push({ role: 'user', content: userMessage });

  return { system, messages };
}

// ────────────────────────────────────────────────────────────────────
// Step 2 — generate classifiers from a saved profile
// ────────────────────────────────────────────────────────────────────
//
// Takes a finalised customer_profile and produces regex-based classifiers that
// risk-score user/group/resource names. The output is a deterministic JSON
// shape consumed by the postgres-native scoring engine.
//
// The v4 implementation also generated separate user/group/agent classifier
// blocks. We keep that structure so the engine can apply different rule sets
// to different principal types.

export function classifierGenerationPrompt({ profile }) {
  const system = `You are an identity security consultant generating regex-based risk classifiers for identity governance scoring.

Given a customer's risk profile, produce a set of regular expressions that detect high-risk principals (users, groups, service principals) by name. The classifiers will be applied case-insensitively to the displayName / email / sAMAccountName / group name.

You must respond with ONLY a valid JSON object (no markdown fencing). Schema:

{
  "version": "1",
  "groupClassifiers": [
    {
      "id": "slug",
      "label": "Human-readable label",
      "description": "Why this group is risky",
      "patterns": ["regex1", "regex2"],
      "score": 0,
      "tier": "critical|high|medium|low",
      "domain": "regulation or risk-domain slug from the profile"
    }
  ],
  "userClassifiers": [
    {
      "id": "slug",
      "label": "Human-readable label",
      "description": "Why this person is risky",
      "patterns": ["regex matching displayName, email or job title"],
      "score": 0,
      "tier": "critical|high|medium|low",
      "domain": "slug"
    }
  ],
  "agentClassifiers": [
    {
      "id": "slug",
      "label": "Service principal / agent label",
      "description": "Why this agent is risky",
      "patterns": ["regex"],
      "score": 0,
      "tier": "critical|high|medium|low",
      "domain": "slug"
    }
  ]
}

Score guidelines:
  - 90–100 → critical (e.g. domain admin equivalents, regulation-specific privileged roles)
  - 70–89  → high     (e.g. broad write access, security-sensitive system admins)
  - 40–69  → medium   (e.g. data stewards, financial approvers)
  - 20–39  → low      (e.g. read-only privileged roles)

Pattern guidelines:
  - Case-insensitive regex (caller applies it that way).
  - Use the profile's local-language variants where applicable.
  - Prefer specific patterns over generic ones (avoid matching every group with "admin").
  - Include both anglicised and original terms if the profile is non-English.
  - Each classifier should have 1–6 patterns. Keep them tight.

Be specific to THIS organisation. For a port authority, include port-system roles. For a hospital, include medical-system roles. For a bank, include trading-system roles.`;

  const user = `CUSTOMER PROFILE:\n${JSON.stringify(profile, null, 2)}\n\nGenerate the classifiers JSON object.`;

  return {
    system,
    messages: [{ role: 'user', content: user }],
  };
}

// Robust JSON extractor — strips markdown fences and trailing prose.
export function extractJson(text) {
  if (!text) return null;
  let cleaned = text.trim();
  // Strip ```json ... ``` or ``` ... ``` fences
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  // Some models prepend an apology before the JSON. Find the first { and the
  // matching closing brace.
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace === -1) return null;
  // Naive but effective: find the last } and try parsing what's between.
  const lastBrace = cleaned.lastIndexOf('}');
  if (lastBrace === -1 || lastBrace < firstBrace) return null;
  const candidate = cleaned.slice(firstBrace, lastBrace + 1);
  try { return JSON.parse(candidate); }
  catch { return null; }
}
