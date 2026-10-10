// The four fixed import templates. One place for the list and for the SQL that reads an
// entity's template through its import profile (profiles without a template are collections).

export const TEMPLATES = ['collection', 'enrichment', 'activity', 'relation'];

export const ENTITY_TEMPLATE_SQL = (alias = 'e') =>
  `COALESCE((SELECT p."template" FROM "OrgImportProfiles" p WHERE p."id" = ${alias}."profileId"), 'collection')`;

/** The template a recipe asks for; recipes without one are collections. */
export function templateOf(recipe) {
  const t = recipe?.template;
  return TEMPLATES.includes(t) ? t : 'collection';
}
