// Organisation truth — the entity-producing templates (collection, enrichment,
// relation) through one applyRecipe.
//
//   applyTemplate(rows, recipe) → { recipe, applied }
//
// `recipe` is the stored, normalised recipe. Collections and enrichments are
// applied as they are. A relation is applied as the one entity it describes
// (templateContracts.js relationEntityDef): each row gets a name column
// "left → right", is keyed on both ends and keeps the ends as attributes
// "left" / "right", so dedupe, the issues and writeRun all stay the collection's.
// A row naming only one end is not a pair: it becomes a 'missingSide' issue.
// The returned `recipe` is the collection-shaped one summarizeApplied takes.
import { relationEntityDef, RELATION_NAME_COLUMN } from '../templateContracts.js';
import { applyRecipe } from './applyRecipe.js';

const cell = (row, column) => String(row?.[column] ?? '').trim();

function relationRows(rows, relation, issues) {
  return rows.map((row, i) => {
    const left = cell(row, relation.left.column);
    const right = cell(row, relation.right.column);
    if (left && right) return { ...row, [RELATION_NAME_COLUMN]: `${left} → ${right}` };
    if (left || right) {
      const missing = left ? relation.right.column : relation.left.column;
      issues.push({ kind: 'missingSide', entityType: relation.type, row: i + 1, detail: `Row ${i + 1} has no ${missing}, so it is not a pair and is left out.` });
    }
    return { ...row, [RELATION_NAME_COLUMN]: '' };
  });
}

export function applyTemplate(rows, recipe) {
  if (recipe.template !== 'relation') return { recipe, applied: applyRecipe(rows, recipe) };
  const entityRecipe = { version: 1, entities: [relationEntityDef(recipe.relation)], relations: [] };
  const issues = [];
  const prepared = relationRows(rows, recipe.relation, issues);
  const applied = applyRecipe(prepared, entityRecipe);
  return { recipe: entityRecipe, applied: { ...applied, issues: [...issues, ...applied.issues] } };
}
