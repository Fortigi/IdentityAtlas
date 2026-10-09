// Organisation → Entities (workstream T6).
//
// Searchable list of entities (GET /api/org-truth/entities?type=&q=&status=),
// filterable by type and status; a row opens the entity detail tab
// (onOpenDetail('org-entity', id, name)), which shows attributes, relations in
// and out, the links to system objects with their confidence, and the source
// with its locator. The detail page reuses EntityGraph for the fan-out.
//
// Props: { onOpenDetail, refreshKey }
import NotBuiltYet from './NotBuiltYet';

export default function EntitiesTab() {
  return <NotBuiltYet what="Entities" workstream="T6" />;
}
