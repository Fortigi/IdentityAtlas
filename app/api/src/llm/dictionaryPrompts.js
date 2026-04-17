// LLM prompt functions for the terminology dictionary.
//
// Three operations:
//   enrichTerm    — describe a term, match business processes, propose classifier links
//   correlateTerms — propose synonym/related relationships with strength scores
//   mineTerms     — extract abbreviations and codes from raw resource/group names

// ─── Enrich ──────────────────────────────────────────────────────────────────

const ENRICH_SYSTEM = `You are a business analyst specializing in IT authorization and identity governance.
You help decode abbreviations and technical terms found in authorization names (group names, access package names, resource names) and link them to known business processes and risk classifiers.
Always respond with valid JSON only — no prose, no markdown fences.`;

export function enrichTermPrompt({ term, searchSnippets = [], activeClassifiers = [] }) {
  const searchSection = searchSnippets.length
    ? `Web search results for context:\n${searchSnippets.map((s, i) => `[${i + 1}] ${s}`).join('\n')}`
    : 'No web search results available — use your training knowledge.';

  const classifierSection = activeClassifiers.length
    ? `Active risk classifiers in this system:\n${activeClassifiers.map(c => `- id="${c.id}" label="${c.label}" domain="${c.domain}"`).join('\n')}`
    : 'No active classifiers configured yet.';

  return {
    system: ENRICH_SYSTEM,
    messages: [{
      role: 'user',
      content: `Analyze the term: "${term}"

${searchSection}

${classifierSection}

Return a JSON object with exactly these fields:
{
  "description": "One clear sentence explaining what this term means in an authorization context.",
  "businessProcesses": ["process name 1", "process name 2"],
  "classifierLinks": [
    {
      "classifierLabel": "exact label from the classifier list above, or empty string if none match",
      "classifierDomain": "domain slug from the classifier list, or empty string",
      "proposedPatterns": ["\\\\bterm\\\\b", "\\\\bvariant\\\\b"],
      "rationale": "Why this term matches this classifier."
    }
  ]
}

Rules:
- businessProcesses: list 1–3 standard business process names this term relates to (e.g. "Procurement", "Human Resources", "Finance"). Use English names.
- classifierLinks: only include entries where a classifier genuinely applies. May be empty array.
- proposedPatterns: JavaScript-compatible regex strings with \\b word boundaries. Include the term itself and obvious variants/abbreviations.
- If the term is too generic or ambiguous, say so in the description and return empty arrays.`
    }],
    temperature: 0.2,
    maxTokens: 512,
  };
}

// ─── Correlate ────────────────────────────────────────────────────────────────

const CORRELATE_SYSTEM = `You are an expert in business terminology and synonym analysis.
You identify relationships between authorization terms: exact synonyms, abbreviations, and related (but not identical) concepts.
Always respond with valid JSON only — no prose, no markdown fences.`;

export function correlateTermsPrompt({ term, candidates }) {
  return {
    system: CORRELATE_SYSTEM,
    messages: [{
      role: 'user',
      content: `Analyze how the term "${term}" relates to each of the following candidate terms from an authorization terminology dictionary.

Candidates:
${candidates.map((c, i) => `${i + 1}. "${c.term}" — ${c.description || '(no description yet)'}`).join('\n')}

Return a JSON array. Include only candidates that have a meaningful relationship with "${term}". Omit unrelated ones.

[
  {
    "term": "exact candidate term string",
    "correlationType": "synonym" or "related",
    "strength": 0.0 to 1.0,
    "rationale": "One sentence explaining the relationship."
  }
]

Strength guide:
- 1.0: exact synonym or abbreviation (INK = inkoop)
- 0.7–0.9: near-synonym, same concept different language/system
- 0.4–0.6: same domain, clearly related
- 0.1–0.3: loosely related, same broad area

correlationType:
- "synonym": interchangeable in practice
- "related": same domain but distinct concepts`
    }],
    temperature: 0.2,
    maxTokens: 1024,
  };
}

// ─── Mine ─────────────────────────────────────────────────────────────────────

const MINE_SYSTEM = `You are an expert at decoding IT naming conventions used in authorization systems.
You extract meaningful abbreviations, codes, and domain terms from group names, resource names, and access package names.
Always respond with valid JSON only — no prose, no markdown fences.`;

export function mineTermsPrompt({ names }) {
  return {
    system: MINE_SYSTEM,
    messages: [{
      role: 'user',
      content: `Extract all meaningful abbreviations, codes, and domain terms from these authorization names:

${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}

Return a JSON array of extracted terms. Each term should be a distinct token that likely represents a business concept, department, system, or process.

[
  {
    "term": "extracted token (uppercase if abbreviation, lowercase if common word)",
    "occurrences": 3,
    "exampleNames": ["name1", "name2"]
  }
]

Rules:
- Extract abbreviations (INK, FIN, HR, PROC), system codes (SAP, CRM), and domain terms (procurement, finance)
- Skip generic structural tokens: grp, grpe, usr, app, sg, dl, all, test, acc, tst, dev, prd, prod
- Skip numbers and GUIDs
- Skip tokens shorter than 2 characters
- Merge case variants: INK and ink → "INK"
- Count how many input names each term appears in`
    }],
    temperature: 0.1,
    maxTokens: 2048,
  };
}

// ─── JSON extraction helper ────────────────────────────────────────────────────

export function parseJsonResponse(text) {
  const trimmed = text.trim();
  // Strip optional markdown fences
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(raw);
}
