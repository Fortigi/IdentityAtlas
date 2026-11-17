// Guard: every table the migrations create has exactly one classification, and
// the clean-database dialog names every piece of person-made work a clean can
// take with it.
//
// Why: Clean database once wiped manual contexts, interviews, tree adjustments
// and more through ON DELETE CASCADE while the dialog promised "your setup is
// kept". The classification (tableClassification.js) is now the single source
// of what a clean removes; this test keeps it complete and honest as tables and
// foreign keys are added.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { readMigrationSchema } from './migrationSchema.js';
import {
  TABLE_CLASSIFICATION, LABELS, GROUPS, ALSO_REMOVED, KEPT_BUT_CHANGED,
  isRemovedLabel, classificationOf, cleanDatabasePlan,
} from './tableClassification.js';
import { repoRoot } from '../lib/repoRoot.js';

const HOW_TO = 'Fix: add (or correct) the table in app/api/src/db/tableClassification.js — pick ONE label '
  + `(${LABELS.join(' | ')}) and write a one-line reason. crawler/derived tables are removed by Admin → Data → `
  + 'Clean database; curated/config/audit/secret tables are kept. Then seed a row for it in '
  + 'app/api/test-utils/cleanDatabaseSeed.js so the contract test checks what a clean does to it.';

const schema = readMigrationSchema();
const classified = TABLE_CLASSIFICATION.map(e => e.table);

describe('table classification — complete', () => {
  it('labels every table the migrations create', () => {
    const missing = [...schema.tables].filter(t => !classified.includes(t)).sort();
    expect(missing, `Unclassified table(s): ${missing.join(', ')}.\n${HOW_TO}`).toEqual([]);
  });

  it('labels no table the migrations do not create (or have dropped)', () => {
    const stale = classified.filter(t => !schema.tables.has(t));
    expect(stale, `Classified but not in the schema: ${stale.join(', ')}. Remove the entry, or fix the name.`).toEqual([]);
  });

  it('labels each table exactly once', () => {
    const dupes = classified.filter((t, i) => classified.indexOf(t) !== i);
    expect(dupes, `Classified more than once: ${dupes.join(', ')}`).toEqual([]);
  });

  it('gives every entry a known label, a reason and a known group', () => {
    const bad = TABLE_CLASSIFICATION.filter(e =>
      !LABELS.includes(e.label)
      || !(e.reason && e.reason.trim().length > 10)
      || (e.group !== null && !GROUPS[e.group])
      || (e.keptGroup && !GROUPS[e.keptGroup])
      || (e.removedGroup && !GROUPS[e.removedGroup]));
    expect(bad.map(e => e.table), HOW_TO).toEqual([]);
  });

  it('only a kept table may have no group, and then everything it holds is named under ALSO_REMOVED', () => {
    const named = new Set(ALSO_REMOVED.flatMap(a => a.tables));
    const bad = TABLE_CLASSIFICATION.filter(e => e.group === null && (isRemovedLabel(e.label) || !named.has(e.table)));
    expect(bad.map(e => e.table)).toEqual([]);
  });
});

// A kept table loses rows on a clean when a CASCADE foreign key leads to a
// removed table — directly, or through another kept table that does.
function cascadeReach() {
  const removed = new Set(TABLE_CLASSIFICATION.filter(e => isRemovedLabel(e.label)).map(e => e.table));
  const reached = new Map(); // kept table -> the parent it cascades from
  let grew = true;
  while (grew) {
    grew = false;
    for (const fk of schema.foreignKeys) {
      if (fk.onDelete !== 'CASCADE' || removed.has(fk.child) || reached.has(fk.child) || fk.child === fk.parent) continue;
      if (removed.has(fk.parent) || reached.has(fk.parent)) { reached.set(fk.child, fk.parent); grew = true; }
    }
  }
  return reached;
}

describe('table classification — honest about cascades', () => {
  it('names every kept table a foreign-key cascade from a removed table can empty', () => {
    const named = new Set(ALSO_REMOVED.flatMap(a => a.tables));
    const unnamed = [...cascadeReach()]
      .filter(([table]) => !named.has(table) && !classificationOf(table).cascadeSafe)
      .map(([table, parent]) => `${table} (ON DELETE CASCADE from ${parent})`);
    expect(unnamed, `A clean removes rows of these kept tables without the dialog saying so:\n  ${unnamed.join('\n  ')}\n`
      + 'Fix: list the table in ALSO_REMOVED (what the person loses, and why), or — when no row can actually be '
      + 'reached — give its entry a cascadeSafe reason.').toEqual([]);
  });

  it('names only tables a cascade can really reach (or that carry a row rule)', () => {
    const reach = cascadeReach();
    const removedRows = (t) => reach.has(t) || isRemovedLabel(classificationOf(t)?.label) || classificationOf(t)?.removeWhere;
    const phantom = ALSO_REMOVED.flatMap(a => a.tables).filter(t => !removedRows(t));
    expect(phantom).toEqual([]);
  });

  it('names every kept table whose link to a removed table is cleared (ON DELETE SET NULL)', () => {
    const removedOrReached = new Set([...TABLE_CLASSIFICATION.filter(e => isRemovedLabel(e.label)).map(e => e.table), ...cascadeReach().keys()]);
    const changed = new Set(KEPT_BUT_CHANGED.flatMap(k => k.tables));
    const keptChild = (fk) => !isRemovedLabel(classificationOf(fk.child).label);
    const unnamed = schema.foreignKeys
      .filter(fk => fk.onDelete === 'SET NULL' && removedOrReached.has(fk.parent) && keptChild(fk))
      .filter(fk => !changed.has(fk.child) && !classificationOf(fk.child).cascadeSafe)
      .map(fk => `${fk.child} → ${fk.parent}`);
    expect(unnamed, 'List the table in KEPT_BUT_CHANGED so the dialog says its link is cleared.').toEqual([]);
  });

  it('classifies the tables the audit found cascading away as kept (curated), not removed', () => {
    for (const t of ['ContextInterviews', 'ContextClaims', 'ContextMemberOverrides', 'ContextTreeAdjustments',
      'WorkbenchInvestigations', 'RoleProposals', 'ContextUploads', 'ManagerHierarchyOverrides', 'SystemOwners']) {
      expect(classificationOf(t).label, t).toBe('curated');
    }
    for (const t of ['CrawlerConfigs', 'RiskProfiles', 'AccountLinkingConfig', 'WorkerConfig']) expect(classificationOf(t).label, t).toBe('config');
    for (const t of ['ReadApiKeys', 'Secrets']) expect(classificationOf(t).label, t).toBe('secret');
  });

  it('keeps manual contexts and uploaded lists: the row rules spare exactly them', () => {
    expect(classificationOf('Contexts').removeWhere).toMatch(/variant <> 'manual'/);
    expect(classificationOf('Contexts').removeWhere).toMatch(/COALESCE\("scopeSystemId" IN/);
    expect(classificationOf('Systems').removeWhere).toBe(`"systemType" IS DISTINCT FROM 'Upload'`);
    expect(classificationOf('RiskScores').removeWhere).toBe('"riskOverride" IS NULL');
  });
});

describe('cleanDatabasePlan — what the dialog shows', () => {
  const plan = cleanDatabasePlan();

  it('lists each removed and kept group once, every table under at least one', () => {
    const keys = (xs) => xs.map(g => g.key);
    expect(new Set(keys(plan.removed)).size).toBe(plan.removed.length);
    expect(new Set(keys(plan.kept)).size).toBe(plan.kept.length);
    const shown = new Set([...plan.removed, ...plan.kept].flatMap(g => g.tables));
    const named = new Set(ALSO_REMOVED.flatMap(a => a.tables));
    expect(classified.filter(t => !shown.has(t) && !named.has(t))).toEqual([]);
  });

  it('puts a mixed table under both lists, and a plain one under only its own', () => {
    const removedTables = plan.removed.flatMap(g => g.tables);
    const keptTables = plan.kept.flatMap(g => g.tables);
    expect(removedTables).toContain('Contexts');
    expect(keptTables).toContain('Contexts');
    expect(keptTables).toContain('Systems');
    expect(removedTables).toContain('_history');
    expect(keptTables).toContain('_history');
    expect(removedTables).not.toContain('SavedMatrixFilters');
    expect(keptTables).not.toContain('Principals');
    expect(keptTables).not.toContain('ManagerHierarchyOverrides');
  });

  it('returns copies, so a caller cannot change the classification', () => {
    plan.alsoRemoved[0].what = 'changed';
    expect(cleanDatabasePlan().alsoRemoved[0].what).not.toBe('changed');
  });
});

describe('docs/admin/data-tab.md says what the dialog says', () => {
  const doc = readFileSync(join(repoRoot(), 'docs/admin/data-tab.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## Danger Zone'));
  const plan = cleanDatabasePlan();

  for (const text of [...plan.removed, ...plan.kept].map(g => g.text).concat(plan.alsoRemoved.map(a => a.what), plan.keptButChanged.map(k => k.what))) {
    it(`mentions: ${text.slice(0, 60)}…`, () => {
      expect(section, 'Update the Danger Zone section of docs/admin/data-tab.md to match tableClassification.js').toContain(text);
    });
  }
});
