// Resource-type badge colours for ResourceDetailPage.
//
// Keys are resourceType values as the crawlers actually emit them. App roles were
// keyed as 'EntraAppRole', which only the demo dataset ever produced — the Entra
// crawler emits the unprefixed 'AppRole' (EntraIDCrawler.Phases.ps1), so against a
// real tenant every app role fell through to the grey default and rendered
// uncoloured. The fixture hid the bug from the product. Migration 058 renames the
// demo dataset's type to match (#719).
//
// Not exhaustive by design: resourceType is an OPEN vocabulary (CSV /
// custom-connector / OData / Omada / midPoint / Azure all supply their own
// names), so an unknown type is legal and the caller's grey default is correct.
export const RESOURCE_TYPE_COLORS = {
  Group:               'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
  AppRole:             'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300',
  EntraDirectoryRole:  'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300',
  EntraAdminUnit:      'bg-teal-100 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300',
};
