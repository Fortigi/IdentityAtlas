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
  const system = `You are an identity security consultant helping refine a customer's organisational risk profile through a conversation.

You must respond with ONLY a valid JSON object in this exact shape:

{
  "assistantMessage": "Your conversational reply to the user in plain prose (1-4 sentences). Answer questions, acknowledge changes, explain what you updated.",
  "profile": { ...the complete updated customer_profile object... },
  "profileChanged": true
}

RULES:
- "assistantMessage" is ALWAYS present and contains your natural-language reply to the user.
- "profile" is the COMPLETE customer_profile schema — same shape as the current profile below. Include ALL fields even if unchanged.
- "profileChanged" is true if you modified anything in the profile, false if the user just asked a question and you didn't change the profile.
- If the user asks a question (e.g. "what software does HBR use?"), research the answer, include it in assistantMessage, and also add any relevant facts to the profile (e.g. known_systems, critical_business_processes). Set profileChanged=true if you added anything.
- If the user requests a change (e.g. "drop NIS2"), apply it, describe what you changed in assistantMessage, and set profileChanged=true.
- NEVER respond with prose outside the JSON object. NEVER use markdown fences. The output must start with { and end with }.

CURRENT PROFILE:
${JSON.stringify(currentProfile, null, 2)}`;

  // Replay the conversation history so the model has context about earlier
  // refinements. Prior assistant messages are summarised to avoid bloating
  // context with duplicated profile JSON.
  const messages = [];
  for (const turn of (transcript || [])) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: turn.content });
    } else if (turn.role === 'assistant') {
      // Use the stored assistantMessage if present, otherwise the old placeholder
      const text = turn.content && turn.content !== '[updated profile applied]'
        ? turn.content
        : '(profile updated)';
      messages.push({ role: 'assistant', content: text });
    }
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

Given a customer's risk profile, produce a set of regular expressions that detect high-risk principals (users, groups, service principals, and resources).

WHAT THE PATTERNS ARE MATCHED AGAINST:
The scoring engine runs each pattern (case-insensitive, as a JavaScript RegExp) against every one of the following fields and records a match if ANY field contains the pattern:
  - For groups/resources: displayName, description, mail, externalId, and every flattened string value in extendedAttributes (samAccountName, OU path, etc.)
  - For users:            displayName, email, jobTitle, department, companyName, givenName, surname, employeeId, externalId, plus flattened extendedAttributes
  - For agents (service principals / managed identities / AI agents): displayName, and extendedAttributes (tags, servicePrincipalType, etc.)

Because every field is tested, patterns you produce must be DISCRIMINATING. A generic word that appears in many non-risky contexts WILL fire on hundreds of irrelevant entities. The single most common failure mode is the LLM producing a pattern that reads like a title in isolation but matches common prefixes or parts of unrelated names.

You must respond with ONLY a valid JSON object (no markdown fencing). Schema:

{
  "version": "1",
  "groupClassifiers": [
    {
      "id": "slug",
      "label": "Human-readable label",
      "description": "Why this group is risky — one sentence, plain English",
      "patterns": ["regex1", "regex2"],
      "score": 0,
      "tier": "critical|high|medium|low",
      "domain": "regulation or risk-domain slug from the profile"
    }
  ],
  "userClassifiers": [ /* same shape, targets user attributes */ ],
  "agentClassifiers": [ /* same shape, targets service principals */ ]
}

SCORE GUIDELINES:
  - 90–100 → critical (domain admin equivalents, regulation-specific privileged roles, SCADA/OT plant operators, payment approvers)
  - 70–89  → high     (broad write access, security-sensitive system admins, data protection leads)
  - 40–69  → medium   (data stewards, financial approvers, GRC contributors)
  - 20–39  → low      (read-only privileged roles, audit viewers)

HARD RULES FOR PATTERNS — follow all of them:

  1. Anchor with word boundaries. Always use \\b on both sides of the main keyword, e.g. \`\\bdomain\\s*admin(istrator)?s?\\b\`, never bare \`admin\`. Without \\b you will match substrings inside unrelated names.

  2. Require a qualifier with common words. Words like "admin", "operator", "user", "manager", "engineer", "owner", "access", "read", "write" are too broad alone. Combine them with a specific system, regulation, domain, or role noun from the profile — e.g. \`\\b(scada|ics|process[\\s_-]?control)\\s+engineer\\b\`, not \`\\bengineer\\b\`.

  3. Never use the bare characters "ot" or "ics" as keywords. Inside JavaScript regex \\b treats underscores as word characters, so "\\bot\\b" in an org with groups like "GG_ROL_PROD_OT_ADMINS" will match, but "\\b(ot|ics)\\b" also fires on any name containing the letters "ot" or "ics" adjacent to a non-word char. Prefer "operational[\\s_-]technology", "ot[\\s_-]?(admin|engineer|operator)", or an explicit system code from the profile.

  4. Exclude news/communications/training/room/mailbox naming conventions. Specifically, make sure your patterns do NOT fire on entities whose name contains any of: "nieuws", "news", "newsletter", "communicatie", "communication", "lokaal", "leslokaal", "room", "meeting", "mailbox", "postbus", "kalender", "calendar", "distributielijst", "distribution list", "shared mailbox". If your keyword is literally the same as one of these (e.g. "room operator"), rewrite the pattern to require additional context.

  5. Prefer system-specific nouns from the profile over generic job categories. If the profile mentions HAMIS, Portbase, SAP-S/4HANA, Dynamics, Pronto, PortXchange, Navigate, ISPS, SOC, etc., build patterns around those exact names. Generic "infrastructure admin" catches too much; "\\bHAMIS[\\s_-]?admin\\b" catches exactly what matters.

  6. Separate role-name patterns from descriptive terms. Patterns like "robot" or "autopilot" or "dynamics" will fire on Azure Autopilot device groups, Microsoft Dynamics CRM administrators, and Hadoop Robot Engineer service accounts — none of which are OT/SCADA. Don't produce patterns that match those words unless you also require a genuine OT/ICS keyword beside them.

  7. Each classifier should have 1–6 patterns. Each pattern must stand alone — the engine OR's them together, so adding patterns NEVER reduces matches. If you can't write a tight pattern for a rule, omit that rule entirely.

  8. Include local-language variants where the profile indicates a non-English organisation (e.g. Dutch + English for a Dutch customer). Put them in the same classifier, not separate ones.

  9. Use \\b anchors, character classes, and non-capturing groups \`(?:...)\`. Do NOT use \`(?i)\`, \`(?s)\`, or other Perl/Python inline flag groups — JavaScript strips them before compile, so relying on them is silently broken.

 10. Be specific to THIS organisation. For a port authority, include port-system roles. For a hospital, include medical-system roles. For a bank, include trading-system roles. Generic "cyber security team" is worse than "\\bSOC[\\s_-]?(Tier[\\s_-]?[1-3]|analyst|team|lead)\\b".

SELF-CHECK BEFORE YOU RESPOND:
  - Mentally run each pattern against "news", "nieuws", "room", "mailbox", "robot", "autopilot", "dynamics crm" — if any pattern matches any of those words standalone, tighten it.
  - Check that every "admin/operator/engineer/user" pattern has a qualifying keyword (system name, regulation, or explicit role).
  - Make sure you did not emit any patterns beginning with \`(?i)\`.`;

  const user = `CUSTOMER PROFILE:\n${JSON.stringify(profile, null, 2)}\n\nGenerate the classifiers JSON object following every hard rule above. Prefer fewer, tighter classifiers over many loose ones.`;

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
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace === -1) return null;
  const lastBrace = cleaned.lastIndexOf('}');
  if (lastBrace === -1 || lastBrace < firstBrace) return null;
  const candidate = cleaned.slice(firstBrace, lastBrace + 1);
  try { return JSON.parse(candidate); }
  catch (err) {
    // Log the parse error + the first 300 chars of the tail — common failure
    // modes are token-limit truncation (no closing brace) or unescaped chars.
    console.warn(`extractJson parse failed: ${err.message}. Tail: ${candidate.slice(-300)}`);
    return null;
  }
}
