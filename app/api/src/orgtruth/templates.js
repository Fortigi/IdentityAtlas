// Organisation truth — the four fixed import templates (T10).
//
//   collection  an object with its own attributes where people and resources come
//               together, each member with a role label (a customer, a project)
//   enrichment  extra attributes on an object that already exists (Identity /
//               Principal / Resource), namespaced by their source
//   activity    time-stamped facts: who did how much on what, when (OrgActivities)
//   relation    pairs between existing things (an SoD matrix), one row per pair
//
// The template lives on the import profile ("OrgImportProfiles"."template",
// migration 088). Collections, enrichments and relations keep using OrgEntities;
// their template is read through OrgEntities."profileId". An entity without a
// profile (or whose profile is gone) counts as a collection, which is what every
// list imported before the templates existed is.
export const TEMPLATES = Object.freeze(['collection', 'enrichment', 'activity', 'relation']);

/**
 * SQL expression: the template of the OrgEntities row under `alias`.
 * The one place this lookup is written; reuse it rather than re-joining.
 */
export function ENTITY_TEMPLATE_SQL(alias = 'e') {
  return `COALESCE((SELECT p."template" FROM "OrgImportProfiles" p WHERE p."id" = ${alias}."profileId"), 'collection')`;
}
