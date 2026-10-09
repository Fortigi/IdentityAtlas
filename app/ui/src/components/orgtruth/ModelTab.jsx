// Organisation → Model (workstream T6).
//
// Draws the meta-graph from GET /api/org-truth/model: one node per entity type
// (with its count, attribute keys and sources), one edge per predicate between
// two types (with its count), and the system types (Identity, Principal,
// Resource, Context) as nodes with the link counts as edges. Always drawable
// whole: it is dozens of nodes, never the instances. Filters: per source, only
// accepted, show proposed. Exports the model as Mermaid text.
//
// Props: { onOpenDetail, refreshKey }
import NotBuiltYet from './NotBuiltYet';

export default function ModelTab() {
  return <NotBuiltYet what="Model" workstream="T6" />;
}
