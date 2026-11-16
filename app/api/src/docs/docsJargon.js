// Retired vocabulary in the documentation.
//
// The product's words changed (governed / non-governed, three assignment types,
// contexts) and the docs kept the old ones on dozens of pages — a reader who
// copies `assignmentType='Governed'` from a page gets a query that returns
// nothing. The UI has had a lint rule for this since the UX audit
// (app/ui/eslint-rules/no-legacy-jargon.js); this is the same rule for docs/.
//
// TWO LISTS, ON PURPOSE. The UI rule lives in another package and checks
// string literals; this one checks markdown. Importing across app/ui ↔ app/api
// would couple two packages over four words, so the list is repeated here and
// docsJargon.guard.test.js fails when the UI rule bans a term this list lacks.

import { readFileSync } from 'fs';
import { join } from 'path';
import { DOCS_ROOT, listPages } from './docsStructure.js';

// Every pattern is a single linear scan (no nested quantifiers). `use` is what
// the failure message tells the author to write instead.
export const TERMS = [
  // Whole words, case-sensitive: "exIST", "lIST" and "consist" are not hits.
  { term: 'SOLL', re: /\bSOLL\b/g, use: 'governed' },
  { term: 'IST', re: /\bIST\b/g, use: 'non-governed' },
  // Contexts replaced org units. Matches "OrgUnit", "org unit", "Org-Units";
  // not the `orgUnitId` column, which is one identifier.
  { term: 'Org Unit', re: /\bOrg[ -]?Units?\b/gi, use: 'context' },
  // Retired assignment types, in any of the spellings a page uses for a value:
  // assignmentType='Governed', assignmentType = "Owner", "assignmentType": "Owner".
  { term: "assignmentType 'Governed'", re: /assignmentType\W{0,6}Governed\b/g, use: 'the governed flag (governed=true)' },
  { term: "assignmentType 'Owner'", re: /assignmentType\W{0,6}Owner\b/g, use: 'a Direct assignment on an ownership resource' },
  { term: 'AppRoleViaGroup', re: /\bAppRoleViaGroup\b/g, use: 'Indirect (the resourceType says it is an app role)' },
  // The singular only: the `SyncOAuth2Grants` phase is a real, current name.
  { term: 'OAuth2Grant', re: /\bOAuth2Grant\b/g, use: 'Direct on a DelegatedPermission resource' },
  { term: 'DirectoryRoleEligible', re: /\bDirectoryRoleEligible\b/g, use: 'Eligible on an EntraDirectoryRole resource' },
  // A cmdlet that does not exist in this product.
  { term: 'Start-FGSync', re: /Start-FGSync/g, use: 'a crawler added in Admin → Crawlers' },
];

// Pages that legitimately keep the old words. `true` exempts the whole page (or
// every page under a folder when the key ends in "/"); a list exempts only the
// named terms. Anything not listed here is either clean or in the baseline.
export const EXEMPT = {
  // The glossary tells a reader who heard the old words what they map to.
  'start/glossary.md': ['SOLL', 'IST'],
  // `OrgUnit` is a live contextType value; these two pages are the ontology's own
  // description of it (core-model.md is generated from ontology/core.ttl).
  'reference/core-model.md': ['Org Unit'],
  'concepts/ontology.md': ['Org Unit'],
  // The guides that name the banned terms in order to ban them.
  'contributing/style-guide.md': true,
  'contributing/ci-pipeline.md': true,
  // Dated assessments: a record of what was found, quoted as it was.
  'security/': true,
  'ux/': true,
  'docs-gap-audit.md': true,
  'docs-remediation-plan.md': true,
  'maintenance-backlog.md': true,
  'architecture/architecture-guidance-review-2026-09.md': true,
  // History: describes earlier versions in their own words.
  'history.md': true,
  // The design archive (Project → Design archive in mkdocs.yml): proposals and
  // superseded designs, kept as written and marked as not describing the product.
  'architecture/design-archive.md': true,
  'architecture/context-redesign.md': true,
  'architecture/context-redesign-plan.md': true,
  'architecture/context-redesign-ui.md': true,
  'architecture/assignment-model-redesign.md': true,
  'architecture/identitytype-design.md': true,
  'architecture/risk-scoring-plugins.md': true,
  'architecture/rule-mining-discussion.md': true,
};

/** The terms a page may use freely: `true` for all of them, else a list. */
export function exemptionFor(page, exempt = EXEMPT) {
  if (exempt[page]) return exempt[page];
  const folder = Object.keys(exempt).find(key => key.endsWith('/') && page.startsWith(key));
  return folder ? exempt[folder] : [];
}

/**
 * How often each banned term occurs in a text, as { term: count } with only the
 * terms that occur. Code fences and inline code count like prose: a sample query
 * with a retired type is the most-copied line on the page.
 */
export function countTerms(text, terms = TERMS) {
  const counts = {};
  for (const { term, re } of terms) {
    const hits = text.match(re);
    if (hits) counts[term] = hits.length;
  }
  return counts;
}

/**
 * Measure a set of pages: { page: { term: count } }, leaving out exempt pages
 * and terms, and pages with no hits. `read` maps a page to its text.
 */
export function measureJargon(pages, read, exempt = EXEMPT) {
  const out = {};
  for (const page of pages) {
    const allowed = exemptionFor(page, exempt);
    if (allowed === true) continue;
    const counts = countTerms(read(page));
    for (const term of allowed) delete counts[term];
    if (Object.keys(counts).length > 0) out[page] = counts;
  }
  return out;
}

/** The measurement for the real docs tree. */
export function docsJargon() {
  return measureJargon(listPages(), page => readFileSync(join(DOCS_ROOT, page), 'utf8'));
}

/** What to write instead of a banned term. */
export function replacementFor(term) {
  return TERMS.find(t => t.term === term)?.use;
}
