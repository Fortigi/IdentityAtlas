// Detail tab of one organisation-truth entity (#org-entity:<id>).
//
// GET /api/org-truth/entities/:id (T4): the row + attributes + source + run +
// relations { out, in } + links. Layout as the other entity detail pages
// (EntityDetailLayout): header, Attributes on the left, the relationship graph on
// the right (RelationGraphPanel driven by useRelationGraph; this entity's
// relations are GET /entities/:id/graph `categories`, see entityGraphShape.js and
// graph/graphNeighbours.js), then Relations
// and Links below, then the evidence other lists (timesheets) give about it
// (OrgEvidenceSection). Links use the LinkedAccountsPanel idiom through OrgLinkTable:
// a target opens its own detail tab, Confirm / Reject / Move need
// useCanImportOrgTruth().
//
// A 404 renders "not found", a 501 "not available yet"; a graph route that is
// not there yet leaves the graph empty with a sentence, the rest still renders.
//
// Props (from DetailRoute): { entityId, onOpenDetail, onClose, onCacheData }
import { useEffect } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useCanImportOrgTruth } from '@ui/hooks/useCanImportOrgTruth';
import useRelationGraph from '@ui/hooks/useRelationGraph';
import RelationGraphPanel from '@ui/components/graph/RelationGraphPanel';
import EntityDetailLayout, { AttributesTable } from '@ui/components/EntityDetailLayout';
import { Section } from '@ui/components/DetailSection';
import EmptyState from '@ui/components/EmptyState';
import { attributeEntries, fetchBlocked } from './orgFormat';
import { toLinkCandidates } from './reviewRows';
import { useSourceDownload } from './sourceDownload';
import { useLinkOverride } from './useLinkOverride';
import OrgLinkTable from './OrgLinkTable';
import OrgEvidenceSection from './OrgEvidenceSection';
import { OrgEntityHeader, OrgEntityRelations } from './OrgEntitySections';
import { FetchState, InlineError } from './orgUi';

export default function OrgEntityDetailPage({ entityId, onOpenDetail, onClose, onCacheData }) {
  const { authFetch } = useAuth();
  const onDownload = useSourceDownload(authFetch);
  const canEdit = useCanImportOrgTruth();
  const base = `/api/org-truth/entities/${encodeURIComponent(entityId)}`;
  const state = useFetch(base, { authFetch });
  const graphState = useFetch(`${base}/graph`, { authFetch });
  const entity = state.data;

  // The root's name and type come with the graph payload itself, so the graph
  // starts once, when that payload is in.
  const graphCore = graphState.data?.core;
  const graph = useRelationGraph({
    root: { kind: 'org-entity', id: entityId, label: graphCore?.displayName || entityId, typeLabel: graphCore?.entityType || 'Organisation' },
    rootCore: graphState.data,
    authFetch,
  });
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
        right={<RelationGraphPanel graph={graph} missing={Boolean(graphState.error)} onOpenDetail={onOpenDetail} />}
      >
        <OrgEntityRelations relations={entity.relations} onOpenDetail={onOpenDetail} />
        <Section title="Links" count={links.length}>
          <InlineError message={error} />
          {links.length === 0
            ? <p className="text-sm text-gray-600 dark:text-gray-400">Not linked to anything in the connected systems.</p>
            : <OrgLinkTable candidates={links} canEdit={canEdit} busy={busy} onOverride={override} onOpenDetail={onOpenDetail} />}
        </Section>
        <OrgEvidenceSection entityId={entityId} onOpenDetail={onOpenDetail} />
      </EntityDetailLayout>
    </div>
  );
}
