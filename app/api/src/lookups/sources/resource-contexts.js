// Lookup source: the contexts of resources an access review is held over.
//
// Any context whose members are resources (`targetType='Resource'`) — a logical
// application synced from a catalogue, a department's file shares, a tag. See
// docs/architecture/context-redesign.md. It used to offer logical applications
// only, which made the review a one-catalogue report. Search, hint and id
// resolution are contextLookup.js's.

import { contextLookup } from './contextLookup.js';

export default contextLookup({
  name: 'resource-contexts',
  displayName: 'Contexts of resources',
  where: `c."targetType" = 'Resource'`,
});
