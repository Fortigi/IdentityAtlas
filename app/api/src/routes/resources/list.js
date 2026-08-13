// Query-building helpers for GET /api/resources, extracted from resources.js so
// the list handler stays under the complexity threshold. Parsing + row-mapping
// are pure and unit-tested directly;
// buildResourceListWhere renders the WHERE + tag join through the caller's
// binder. Covered end-to-end by resources.test.js. SQL moved verbatim.

import { parseJsonbColumn } from '../../lib/jsonb.js';
import { buildFilterWhere, parseTags } from '../tags.js';
import { extractRelFilters, buildRelationshipWhere } from '../../lib/referenceFilters.js';
import { parseListParams } from '../../lib/listParams.js';

// Parse the list query params + attribute/tag/reference filters. Pure. The tag
// filter is pulled out of the attribute object (which extractRelFilters then
// mutates) so it isn't validated as a real column.
export function parseResourceListParams(req) {
  const { search, limit, offset, attrFilters } = parseListParams(req);
  const resourceType = (req.query.resourceType || '').trim();
  const systemId = (req.query.systemId || '').trim();
  const tagId = req.query.tagId ? String(req.query.tagId) : null;

  let resourceTagFilter = null;
  if (attrFilters['__resourceTag']) {
    resourceTagFilter = String(attrFilters['__resourceTag']);
    delete attrFilters['__resourceTag'];
  }
  // Backward compat: also accept __groupTag
  if (!resourceTagFilter && attrFilters['__groupTag']) {
    resourceTagFilter = String(attrFilters['__groupTag']);
    delete attrFilters['__groupTag'];
  }
  // Reference-field (rel.*) filters — applied as correlated count subqueries.
  const relFilters = extractRelFilters(attrFilters);

  return { search, resourceType, systemId, tagId, limit, offset, attrFilters, resourceTagFilter, relFilters };
}

// Build the WHERE clause + optional tag-filter JOIN for the list query, binding
// values through the caller's `bind`. Returns { where, resourceTagJoin }.
export function buildResourceListWhere(req, parsed, colNames, bind) {
  const { search, resourceType, systemId, tagId, attrFilters, resourceTagFilter, relFilters } = parsed;

  let where = '1=1';
  // Hide soft-deleted resources by default; ?includeDeleted=true reveals them.
  if (req.query.includeDeleted !== 'true') where += ` AND r."deletedAt" IS NULL`;
  if (search) {
    const s = bind(`%${search}%`);
    where += ` AND (r."displayName" ILIKE ${s} OR r."description" ILIKE ${s})`;
  }
  if (resourceType) {
    where += ` AND r."resourceType" = ${bind(resourceType)}`;
  } else if (req.query.includeBusinessRoles !== 'true') {
    // The UI grid lists actual-access resources only; business roles / access
    // packages live on the governance (SOLL) side and are hidden by default.
    // The Excel export passes ?includeBusinessRoles=true.
    where += ` AND (r."resourceType" IS NULL OR r."resourceType" <> 'BusinessRole')`;
  }
  if (systemId && /^\d+$/.test(systemId)) {
    where += ` AND r."systemId" = ${bind(parseInt(systemId, 10))}`;
  }
  if (tagId) {
    where += ` AND EXISTS (
      SELECT 1 FROM "GraphTagAssignments" ta
      INNER JOIN "GraphTags" t ON ta."tagId" = t.id
      WHERE ta."tagId" = ${bind(tagId)} AND ta."entityId" = UPPER(r.id::text)
        AND t."entityType" IN ('resource', 'group')
    )`;
  }

  let resourceTagJoin = '';
  if (resourceTagFilter) {
    resourceTagJoin = `
      INNER JOIN "GraphTagAssignments" _rta ON _rta."entityId" = UPPER(r.id::text)
      INNER JOIN "GraphTags" _rt ON _rta."tagId" = _rt.id AND _rt."name" = ${bind(resourceTagFilter)} AND _rt."entityType" IN ('resource', 'group')`;
  }
  where += buildFilterWhere(attrFilters, colNames, 'r', bind);
  where += buildRelationshipWhere(relFilters, 'resources', 'r');

  return { where, resourceTagJoin };
}

// Map a raw list row → the API shape (parsed extAttrs, tags, backward-compat
// group* aliases). Pure.
export function mapResourceRow(row) {
  const { tagString, extendedAttributes, ...rest } = row;
  return {
    ...rest,
    extendedAttributes: parseJsonbColumn(extendedAttributes),
    tags: parseTags(tagString),
    // backward compat aliases
    groupId: row.id,
    groupDisplayName: row.displayName,
    groupDescription: row.description,
    groupTypeCalculated: row.resourceType,
  };
}
