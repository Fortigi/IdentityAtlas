// Organisation truth — the dry-run: what a recipe would do to a source,
// without writing anything.
//
//   dryRun({ source, recipe, linkRules, mode, profileName })
//     → { ok: false, errors: string[] }            the recipe or rules do not fit
//     | { ok: true, report }
//
// report (the wizard's data-quality step reads exactly this):
//   {
//     rows:       number                      data rows in the source
//     columns:    ColumnProfile[]             profileColumns.js
//     entities:   { [type]: { total, duplicateKeys, emptyKeys } }
//     relations:  { [predicate]: number }
//     links:      linking/stats.js linkStats(entities, linkRules)
//     wouldClose: { [type]: number }          full mode: open entities of the profile
//                                             this source no longer contains
//     issues:     Issue[]                     applyRecipe.js issues, the first ISSUE_REPORT_LIMIT
//     issueCount: number                      all issues
//   }
//
// DECISION (T1, for T5): the handover's body is { sourceId, recipe, linkRules,
// mode }. A dry-run of a NEW profile has nothing to close, so `wouldClose` is
// only computed when the body also names an existing `profileId` (the repeat
// import, step 5 "comparison with the previous run"); otherwise it is {}.
//
// A source that no longer parses throws ListParseError (the route answers 400).
import { query } from '../../db/connection.js';
import { validateRecipe, validateLinkRules, normalizeRecipe, normalizeLinkRules } from '../contracts.js';
import { linkStats } from '../linking/stats.js';
import { readSourceTable } from './sourceStore.js';
import { profileColumns } from './profileColumns.js';
import { applyRecipe, summarizeApplied, entityKey } from './applyRecipe.js';

export const ISSUE_REPORT_LIMIT = 500;

export async function countWouldClose(profileName, entities) {
  const open = await query(`
    SELECT "entityType", "canonicalKey" FROM "OrgEntities"
     WHERE "validTo" IS NULL AND "origin" = 'import'
       AND "profileId" IN (SELECT "id" FROM "OrgImportProfiles" WHERE "name" = $1)`, [profileName]);
  const present = new Set(entities.map(e => entityKey(e.entityType, e.canonicalKey)));
  const out = {};
  for (const row of open.rows) {
    if (present.has(entityKey(row.entityType, row.canonicalKey))) continue;
    out[row.entityType] = (out[row.entityType] ?? 0) + 1;
  }
  return out;
}

export async function dryRun({ source, recipe, linkRules, mode, profileName = null }) {
  const table = await readSourceTable(source);
  const rules = linkRules ?? [];
  const errors = [
    ...validateRecipe(recipe, table.columns).errors,
    ...validateLinkRules(rules, recipe).errors,
  ];
  if (errors.length > 0) return { ok: false, errors };

  const nRecipe = normalizeRecipe(recipe);
  const applied = applyRecipe(table.rows, nRecipe);
  const summary = summarizeApplied(applied, nRecipe);
  return {
    ok: true,
    report: {
      rows: table.rows.length,
      columns: profileColumns(table.columns, table.rows),
      entities: summary.entities,
      relations: summary.relations,
      links: await linkStats(applied.entities, normalizeLinkRules(rules)),
      wouldClose: mode === 'full' && profileName ? await countWouldClose(profileName, applied.entities) : {},
      issues: applied.issues.slice(0, ISSUE_REPORT_LIMIT),
      issueCount: applied.issues.length,
    },
  };
}
