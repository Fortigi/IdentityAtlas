// Lookup source: the organisational units a unit report is run on — units of
// accounts or of people (a unit of resources has the Entitlement Pivot
// instead). Search, hint and id resolution are contextLookup.js's.

import { contextLookup } from './contextLookup.js';

export default contextLookup({
  name: 'unit-contexts',
  displayName: 'Units of accounts or people',
  where: `c."contextCategory" = 'OrganizationalUnit' AND c."targetType" IN ('Principal', 'Identity')`,
});
