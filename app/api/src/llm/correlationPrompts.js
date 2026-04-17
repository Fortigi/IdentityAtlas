// Identity Atlas v5 — account correlation ruleset prompts.
//
// Similar to riskPrompts.js, these prompts drive the account correlation wizard.
// Each function returns `{ system, messages }` ready for `chatWithSavedConfig()`.

// ────────────────────────────────────────────────────────────────────
// Step 1 — initial correlation ruleset generation
// ────────────────────────────────────────────────────────────────────

export function correlationRulesetGenerationPrompt({ domain, organizationName, hints, systems }) {
  const system = `You are an identity security consultant specialising in cross-system account correlation.

Your task is to generate a ruleset for linking user accounts across different systems to real-world identities. This ruleset defines correlation signals (attributes that indicate accounts belong to the same person) and account type rules (patterns to classify accounts as human vs service/shared).

You must respond with ONLY a valid JSON object (no markdown fencing, no explanation before or after). The JSON must follow this exact schema:

{
  "correlation_ruleset": {
    "correlation_signals": [
      {
        "name": "signal-name",
        "signal": "attribute-name",
        "type": "exact|fuzzy|domain|prefix|pattern",
        "weight": 0-100,
        "description": "What this signal means"
      }
    ],
    "account_type_rules": [
      {
        "accountType": "Human|Service|Shared|External",
        "patterns": ["regex-pattern-1", "pattern-2"],
        "priority": 1,
        "description": "When this rule applies"
      }
    ],
    "hr_source_config": {
      "enabled": false,
      "sourceSystem": null,
      "indicators": []
    }
  }
}

Correlation signals — attributes to match across systems:
- Exact: email addresses, employee IDs, UPNs
- Fuzzy: display names (allowing for variations)
- Domain: same email domain = same org
- Prefix: UPN prefix matches (e.g. john.doe@ in multiple systems)
- Pattern: custom regex for system-specific identifiers

Weights:
- 90-100: Strong signals (email, employee ID)
- 70-89: Moderate signals (UPN prefix, manager relationship)
- 40-69: Weak signals (display name fuzzy match, department)
- 20-39: Very weak signals (location, job title)

Account type rules — identify non-human accounts:
- Service accounts: patterns like "svc-", "app-", "robot-", "api-", "system-", "azuread_*", "service_*"
- Shared accounts: "admin", "shared-", "team-", "generic-"
- External: guest accounts, B2B users
- Human: everything else (default)

Priority determines evaluation order (1 = highest). Match the account patterns to the organisation's naming conventions.`;

  const userParts = [];
  userParts.push(`Generate a correlation ruleset for the organisation at domain "${domain}".`);
  if (organizationName) userParts.push(`Organisation name: "${organizationName}".`);
  if (hints) userParts.push(`User-supplied context: ${hints}`);
  if (systems && systems.length > 0) {
    userParts.push(`\nConnected systems: ${systems.map(s => s.systemName || s.name).join(', ')}`);
  }
  userParts.push(`\nGenerate the correlation_ruleset JSON object as specified. Focus on signals and account type rules that are relevant to this organisation's industry and naming patterns.`);

  return {
    system,
    messages: [{ role: 'user', content: userParts.join('\n\n') }],
  };
}

// ────────────────────────────────────────────────────────────────────
// Step 2 — conversational refinement
// ────────────────────────────────────────────────────────────────────

export function correlationRulesetRefinementPrompt({ currentRuleset, transcript, userMessage }) {
  const system = `You are an identity security consultant helping refine account correlation rules through a conversation.

You must respond with ONLY a valid JSON object in this exact shape:

{
  "assistantMessage": "Your conversational reply to the user in plain prose (1-4 sentences). Acknowledge changes, explain what you updated.",
  "ruleset": { ...the complete updated correlation_ruleset object... },
  "rulesetChanged": true
}

RULES:
1. If the user asks a question without requesting changes, set rulesetChanged: false and keep the ruleset unchanged
2. If the user requests changes ("add X", "remove Y", "adjust weights"), update the ruleset and set rulesetChanged: true
3. Always return the COMPLETE ruleset, not just the changed parts
4. Keep correlation signals and account type rules focused and relevant
5. Explain your reasoning briefly in the assistantMessage
6. When adding new signals, suggest appropriate weights based on signal strength
7. When modifying account type patterns, ensure they're valid regex and don't overlap

The user might ask you to:
- Add or remove correlation signals
- Adjust signal weights
- Add account type patterns for their specific naming conventions
- Enable/configure HR source integration
- Explain why a particular signal or rule was included`;

  const messages = [];

  // Add conversation history
  if (transcript && transcript.length > 0) {
    messages.push(...transcript);
  }

  // Add current state
  messages.push({
    role: 'assistant',
    content: `Current ruleset:\n\`\`\`json\n${JSON.stringify(currentRuleset, null, 2)}\n\`\`\``,
  });

  // Add user's new message
  messages.push({
    role: 'user',
    content: userMessage,
  });

  return { system, messages };
}

// ────────────────────────────────────────────────────────────────────
// JSON extraction helper
// ────────────────────────────────────────────────────────────────────

export function extractJson(text) {
  if (!text) return null;

  // Strip markdown fences if present
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '');
  cleaned = cleaned.replace(/\s*```\s*$/i, '');
  cleaned = cleaned.trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // If direct parse fails, try to find JSON object boundaries
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}
