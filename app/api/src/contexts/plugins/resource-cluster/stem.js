// Normalise a resource display name to a "stem" used by the resource-cluster
// plugin. Extracted into its own module so it's easy to unit-test and so the
// legacy risk-scoring path can keep using the same implementation until it's
// removed.
//
// The regexes are intentionally conservative — prefixes/suffixes that don't
// match just pass through, so the stem equals the original name. The caller
// (the plugin) drops stems shorter than N characters so we don't produce a
// cluster-per-resource in the no-signal case.

export function getGroupStem(name) {
  if (!name) return '';
  let stem = name;
  // Common group-name prefixes.
  stem = stem.replace(/^(SG|DL|AG|SEC|M365|AAD|GRP|GG|CG|PS|TS)[-_]/i, '');
  // Environment suffixes — run twice so "foo_P_ACC" strips both.
  stem = stem.replace(/[-_](P|A|T|D|ACC|TST|DEV|ONT|STG|SBX|UAT|QA|PRD|PROD)$/i, '');
  stem = stem.replace(/[-_](P|A|T|D|ACC|TST|DEV|ONT|STG|SBX|UAT|QA|PRD|PROD)$/i, '');
  // Role suffixes (EN + NL) — same deal, run twice.
  stem = stem.replace(/[-_](Admin|Admins|Users|Members|Owners|ReadOnly|FullAccess|Beheer|Gebruikers|Viewers|Readers|Writers|Contributors|Leden|Eigenaars)$/i, '');
  stem = stem.replace(/[-_](Admin|Admins|Users|Members|Owners|ReadOnly|FullAccess|Beheer|Gebruikers|Viewers|Readers|Writers|Contributors|Leden|Eigenaars)$/i, '');
  // Collapse whitespace / dashes / underscores into a single dash.
  stem = stem.replace(/[_\-\s]+/g, '-');
  stem = stem.replace(/^-+|-+$/g, '').toLowerCase();
  return stem;
}
