// Organisation truth — the entities a stored source yields under a recipe,
// for POST /links/detect (owned by workstream T2).
//
//   loadSourceEntities({ sourceId, recipe, entityType }, importers?) → entity[] | null (unknown source)
//
// Reuses workstream T1's pure import pieces instead of a second parser:
//   import/parse.js        parseList(buffer, { fileName, mimeType }) → { columns, rows }
//   import/applyRecipe.js  applyRecipe(rows, recipe) → { entities, relations, issues }
// They are imported lazily so this branch works before T1 merges: until then
// the importer rejects and the route answers 501 with a sentence
// (SourceParsingUnavailable), and the wizard can send `rows` instead.
// `importers` is injectable so the tests need no T1 files.
import { queryOne } from '../../db/connection.js';

export class SourceParsingUnavailable extends Error {}

// Specifiers held in variables so the bundler does not try to resolve a file
// that does not exist on this branch yet.
const PARSE_MODULE = '../import/parse.js';
const APPLY_MODULE = '../import/applyRecipe.js';
export const defaultImporters = {
  parse: () => import(PARSE_MODULE),
  apply: () => import(APPLY_MODULE),
};

async function importOrUnavailable(load) {
  try {
    return await load();
  } catch (err) {
    throw new SourceParsingUnavailable(`Parsing a stored source is not available yet (${err.message}).`);
  }
}

export async function loadSourceEntities({ sourceId, recipe, entityType }, importers = defaultImporters) {
  const source = await queryOne(
    'SELECT "content", "fileName", "mimeType" FROM "OrgSources" WHERE "id" = $1',
    [sourceId],
  );
  if (!source) return null;
  const { parseList } = await importOrUnavailable(importers.parse);
  const { applyRecipe } = await importOrUnavailable(importers.apply);
  const { rows } = await parseList(source.content, { fileName: source.fileName, mimeType: source.mimeType });
  const { entities } = applyRecipe(rows, recipe);
  return (entities ?? []).filter(e => e.entityType === entityType);
}
