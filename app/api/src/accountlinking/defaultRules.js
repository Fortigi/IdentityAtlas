// Identity Atlas — Account Linking default dictionary.
//
// Deterministic rules used to (a) classify an orphan account's type and
// (b) score whether an orphan account belongs to an existing Identity. No LLM
// is involved — the dictionary is shipped with sensible defaults and is
// editable per-tenant via Admin → Account Linking (AccountLinkingConfig.rules).
//
// signals          — weighted match rules; an orphan links to the identity with
//                    the highest summed weight that clears `linkThreshold`.
// accountTypeRules  — regex patterns (lowest `priority` wins) that classify an
//                    account as Admin / Guest / Service / Shared. Anything that
//                    matches nothing is "Secondary" (a plain extra human account).
// onlyLinkTypes     — only these account types are attached to a person; Service
//                    and Shared accounts are left for the Orphaned Accounts context.

export const DEFAULT_RULES = {
  signals: [
    { name: 'employeeId',  type: 'exact',  field: 'employeeId', weight: 95 },
    { name: 'email',       type: 'exact',  field: 'email',      weight: 90 },
    {
      name: 'emailPrefix', type: 'prefix', field: 'email', weight: 80,
      stripPrefixes: ['adm-', 'adm_', 'a-', 'a_', 'admin-', 'admin_', 'ext-', 'ext_', 'svc-', 's-'],
    },
    {
      name: 'displayName', type: 'fuzzy', field: 'displayName', weight: 45,
      stripSuffixes: ['(admin)', '(adm)', '- admin', '(ext)', '(extern)', '(guest)', '(svc)', '(service)'],
    },
  ],
  accountTypeRules: [
    { accountType: 'Admin',   priority: 1, patterns: ['^adm[-_]', '^a[-_]', '[-_]admin@', '\\badmin\\b'] },
    { accountType: 'Guest',   priority: 1, patterns: ['#ext#'] },
    { accountType: 'Service', priority: 2, patterns: ['^svc[-_]', '^s[-_]', '\\bservice account\\b'] },
    { accountType: 'Shared',  priority: 3, patterns: ['\\broom\\b', '\\bequipment\\b', '\\bshared\\b', '\\bmailbox\\b'] },
  ],
  linkThreshold: 70,
  onlyLinkTypes: ['Admin', 'Guest', 'Secondary'],
};
