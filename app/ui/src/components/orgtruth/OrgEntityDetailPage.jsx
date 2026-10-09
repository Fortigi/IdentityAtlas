// Detail tab of one organisation-truth entity (#org-entity:<id>).
//
// GET /api/org-truth/entities/:id (T4): the row + attributes + source + run +
// relations { out, in } + links. Layout as the other entity detail pages
// (EntityDetailLayout): header, Attributes on the left, the radial graph on the
// right (EntityGraph driven by useExpandableGraph; its first ring is
// GET /entities/:id/graph `categories`, see entityGraphShape.js), then Relations
// and Links below. Links use the LinkedAccountsPanel idiom through OrgLinkTable:
// a target opens its own detail tab, Confirm / Reject / Move need
// useCanImportOrgTruth().
//
// A 404 renders "not found", a 501 "not available yet"; a graph route that is
// not there yet leaves the graph empty with a sentence, the rest still renders.
//
// Props (from DetailRoute): { entityId, onOpenDetail, onClose, onCacheData }
import { useEffect, useMemo } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useCanImportOrgTruth } from '@ui/hooks/useCanImportOrgTruth';
import useExpandableGraph from '@ui/hooks/useExpandableGraph';
import EntityGraph from '@ui/components/EntityGraph';
import ExpandedItemsList from '@ui/components/ExpandedItemsList';
import EntityDetailLayout, { AttributesTable } from '@ui/components/EntityDetailLayout';
import { Section } from '@ui/components/DetailSection';
import EmptyState from '@ui/components/EmptyState';
import { getRootNodes } from '@ui/components/entityGraphShape';
import { attributeEntries, fetchBlocked } from './orgFormat';
import { toLinkCandidates } from './reviewRows';
import { useSourceDownload } from './sourceDownload';
import { useLinkOverride } from './useLinkOverride';
import OrgLinkTable from './OrgLinkTable';
import { OrgEntityHeader, OrgEntityRelations } from './OrgEntitySections';
import { FetchState, InlineError, CARD } from './orgUi';

function GraphPanel({ entity, graph, graphMissing, onOpenDetail }) {
  return (
    <div className="space-y-4">
      <div className={`${CARD} p-3`}>
        {graphMissing ? (
          <p className="p-6 text-center text-sm text-gray-600 dark:text-gray-400">The relationship graph is not available yet.</p>
        ) : (
          <EntityGraph
            centerLabel={entity.entityType}
            centerSubLabel={entity.displayName}
            nodes={graph.nodesWithExpansion}
            expandedPath={graph.expandedPath}
            onNodeClick={graph.handleNodeClick}
          />
        )}
        {graph.pathDepth > 0 && (
          <p className="text-xs text-center text-gray-600 dark:text-gray-400 pb-2">
            {graph.activeListLabel} ·{' '}
            <button type="button" onClick={graph.reset} className="underline hover:text-gray-800 dark:hover:text-gray-200">collapse</button>
          </p>
        )}
      </div>
      {graph.pathDepth > 0 && (
        <ExpandedItemsList label={graph.activeListLabel} items={graph.activeListItems}
          loading={graph.loading} onOpenDetail={onOpenDetail} />
      )}
    </div>
  );
}

export default function OrgEntityDetailPage({ entityId, onOpenDetail, onClose, onCacheData }) {
  const { authFetch } = useAuth();
  const onDownload = useSourceDownload(authFetch);
  const canEdit = useCanImportOrgTruth();
  const base = `/api/org-truth/entities/${encodeURIComponent(entityId)}`;
  const state = useFetch(base, { authFetch });
  const graphState = useFetch(`${base}/graph`, { authFetch });
  const entity = state.data;

  const rootNodes = useMemo(() => getRootNodes('org-entity', graphState.data), [graphState.data]);
  const graph = useExpandableGraph({ rootEntityKind: 'org-entity', rootEntityId: entityId, rootNodes, authFetch });
  const reloadAll = () => { state.reload(); graphState.reload(); };
  const { busy, error, override } = useLinkOverride({ authFetch, onDone: reloadAll });

  // Relabel a tab opened from a URL (it only had the id) once the name is in.
  useEffect(() => {
    if (entity?.displayName) onCacheData?.(entityId, 'org-entity', entity);
  }, [entity, entityId, onCacheData]);

  if (state.error?.message === 'HTTP 404') {
    return <EmptyState title="Entity not found" hint="It may have been removed by a later import." actionLabel="Close" onAction={onClose} />;
  }
  if (fetchBlocked(state)) return <FetchState state={state} what="Entity" />;
  if (!entity) return null;

  const links = toLinkCandidates(entity.links);

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <OrgEntityHeader entity={entity} onDownload={onDownload} onClose={onClose} />
      <EntityDetailLayout
        left={<AttributesTable entries={attributeEntries(entity)} />}
        right={<GraphPanel entity={entity} graph={graph} graphMissing={Boolean(graphState.error)} onOpenDetail={onOpenDetail} />}
      >
        <OrgEntityRelations relations={entity.relations} onOpenDetail={onOpenDetail} />
        <Section title="Links" count={links.length}>
          <InlineError message={error} />
          {links.length === 0
            ? <p className="text-sm text-gray-600 dark:text-gray-400">Not linked to anything in the system truth.</p>
            : <OrgLinkTable candidates={links} canEdit={canEdit} busy={busy} onOverride={override} onOpenDetail={onOpenDetail} />}
        </Section>
      </EntityDetailLayout>
    </div>
  );
}
