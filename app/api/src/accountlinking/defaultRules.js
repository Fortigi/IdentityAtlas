// Identity Atlas — Account Linking default dictionary.
//
// Deterministic rules used to (a) classify an orphan account's type and
// (b) score whether an orphan account belongs to an existing Identity. No LLM
// is involved — the dictionary is shipped with sensible defaults and is
// editable per-tenant via Admin → Account Linking (AccountLinkingConfig.rules).
//
// signals          — weighted match rules; an orphan links to the identity with
//                    the highest summed weight that clears `linkThreshold`.
//                    Strong signals (employeeId/email) are near-certain; name
//                    signals are softer (graded) so a person's accounts under
//                    different email conventions (r.euson vs robin.euson) still
//                    link — at a lower, honest confidence the analyst can review.
// accountTypeRules  — regex patterns (lowest `priority` wins) that classify an
//                    account as Admin / Guest / Service / Shared. Anything that
//                    matches nothing is "Secondary" (a plain extra human account).
// linkThreshold     — minimum confidence to auto-link. Tunable in the UI (slider).
// onlyLinkTypes     — only these account types are attached to a person; Service
//                    and Shared accounts are left for the Orphaned Accounts context.
// allowNameOnlyLinks — when true (the default), a match that rests only on name
//                    signals links if the name points at exactly one person, and
//                    is held for review if it does not. Set it to false to hold
//                    back every name-only match; see the name-uniqueness guard
//                    in engine.js.

export const DEFAULT_RULES = {
  signals: [
    { name: 'employeeId', type: 'exact',  field: 'employeeId', weight: 95 },
    { name: 'email',      type: 'exact',  field: 'email',      weight: 90 },
    {
      name: 'emailPrefix', type: 'prefix', field: 'email', weight: 80,
      stripPrefixes: ['adm-', 'adm_', 'a-', 'a_', 'admin-', 'admin_', 'ext-', 'ext_', 'svc-', 's-'],
    },
    // Graded name signals (mutually exclusive — the best level wins). Names are
    // parsed from displayName with role/company qualifiers like "(OGD)" or
    // "(ADM-azure)" stripped, so "Euson, Robin (OGD)" and "(ADM-azure) Euson, Robin"
    // both reduce to {euson, robin}.
    { name: 'fullName',       type: 'name', level: 'full',           weight: 60 },
    { name: 'surnameInitial', type: 'name', level: 'surnameInitial', weight: 45 },
  ],
  accountTypeRules: [
    { accountType: 'Admin',   priority: 1, patterns: ['^adm[-_]', '^a[-_]', '[-_]admin@', '\\badmin\\b', '\\(adm'] },
    { accountType: 'Guest',   priority: 1, patterns: ['#ext#'] },
    { accountType: 'Service', priority: 2, patterns: ['^svc[-_]', '^s[-_]', '\\bservice account\\b'] },
    { accountType: 'Shared',  priority: 3, patterns: ['\\broom\\b', '\\bequipment\\b', '\\bshared\\b', '\\bmailbox\\b'] },
  ],
  // Auto-link when summed confidence ≥ this. A single fullName match lands at
  // 60, which clears this bar — so the name-uniqueness guard, not the threshold,
  // is what stops a name-only link to a namesake. Raise it via the slider to
  // require stronger evidence from every match.
  linkThreshold: 50,
  onlyLinkTypes: ['Admin', 'Guest', 'Secondary'],
  // Policy: a name match on its own may attach an account to a person, but only
  // while that name points at exactly one of them. A name a second person
  // answers to at the level the match rests on — spelled the same, or sharing
  // its surname and given initial where nobody is spelled it exactly — says
  // nothing about which of the two the account belongs to, and the wrong one
  // then inherits that person's access review, risk score and leaver handling.
  // Those matches are held for review on the run instead. Sources that carry
  // nothing but a display name (badge systems, many ERPs) depend on the unique
  // case: set this to false only for a tenant that wants a name to never be
  // evidence enough, and accepts that such a source stops linking entirely.
  allowNameOnlyLinks: true,
};
