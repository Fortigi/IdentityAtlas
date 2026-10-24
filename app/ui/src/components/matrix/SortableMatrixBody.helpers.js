// Pure helpers for SortableMatrixBody.jsx, kept out of the component file so React Fast
// Refresh can hot-swap it (react-refresh/only-export-components).

// The rows that own their position, and can therefore be dragged. A group's
// nested sub-rows and the resources drawn under the business role(s) granting
// them travel with the row they belong to — and a resource several roles grant
// has a row under each of them, all sharing one resource id, so they could not
// each be a sortable of their own anyway.
export function sortableRowIds(rows) {
  return (rows || []).filter(r => !r.isNestedRow && !r.roleParentId).map(r => r.id);
}
