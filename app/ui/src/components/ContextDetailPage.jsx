import { useEffect, useReducer, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import ContextDetailHeader from './ContextDetailHeader';
import { profileFor } from './contexts/profiles/profiles';
import ContextDetails from './contexts/ContextDetails';
import ContextPeople from './contexts/ContextPeople';
import UploadProvenance from './contexts/UploadProvenance';
import ContextEditModal from './contexts/ContextEditModal';
import ContextRelationshipsTab from './ContextRelationshipsTab';
import ProfileBody from './contexts/page/ProfileBody';
import { TimelineSection, DiffSection, RiskSection } from './contexts/page/PageSections';
import useFeatures from '@ui/hooks/useFeatures';
import { useHasPermission } from '@ui/auth/usePermissions';
import { useIsSharedView } from '@ui/contexts/SharedViewContext';
import { useDialog } from '@ui/components/dialogContext';
import { promptAndAddSubUnit } from './contexts/addSubUnit';
import { useContextMembers, MEMBER_PAGE_SIZE } from './contexts/useContextMembers';
import { useContextDetail, contextPageView, listsMembers } from './contexts/useContextDetail';
import { useOrgKnowledge } from '@ui/hooks/useOrgKnowledge';
import ClaimsProvider from './contexts/interviews/ClaimsProvider';
import { useUnitInvestigations } from './contexts/page/useUnitProposals';
import { proposalCount } from './contexts/page/unitProposals';
import { workbenchRouteId } from './workbench/workbench.link';

// ─── Context Detail Page ──────────────────────────────────────────────────────
// One page, two readers (decided 2026-10-20, permission-driven):
//   business view  no data.write.contexts (or a shared read-only view): the
//                  name and one sentence on what it is, who answers for it,
//                  Download report, the people (current and former), what we
//                  know about it and its sub-units. No Edit, no review, no
//                  sources, no Timeline. Standalone, the app shell hides its
//                  navigation too (AppHeader) — the breadcrumb is the way around.
//   analyst view   with it (auth off counts): the same page plus Add information,
//                  the attention line ("2 to decide · 13 to review · 1 to correct
//                  in the source"), the review buttons, Sources, Change requests,
//                  the Timeline and Risk at the foot, the raw values under More
//                  details, and Edit / Add sub-unit / Edit members on a context
//                  created here (the only kind whose edits last).
// A unit or an application (a template profile) reads as one column of sections:
// People → What we know → Sources → Change requests → Sub-units → Timeline
// (contexts/page/ProfileBody.jsx). Anything else keeps the generic page: its
// details, sub-units and members, then the Timeline. Loaded via /api/contexts/:id.
// Standalone, document.title is the unit name. A unit or an application sits in
// one ClaimsProvider, shared by its header, People, What we know and Sources.
//
// `embedded`: rendered inside the Contexts page's right pane — no close
// button (onClose then only runs after a delete), an "Open as page" item
// (onOpenAsPage(attrs)) instead. `refreshKey` re-reads the context when the
// tree beside it changed it; `onEdited` tells the page an edit here did.

export default function ContextDetailPage({ contextId, onCacheData, onClose, onOpenDetail, embedded = false, onOpenAsPage, refreshKey, onEdited }) {
  const { authFetch } = useAuth();
  const features = useFeatures();
  const dialog = useDialog();
  const analyst = useIsAnalyst();
  const knowledge = useOrgKnowledge();
  const sharedView = useIsSharedView();
  // What the page may link to: nothing but the shell's own handler when read-only
  // (a context owner may open no member, person or sub-unit page).
  const openEntity = linkTarget(sharedView, onOpenDetail);
  const [editing, setEditing] = useState(false);
  // Goes up whenever something on the page may have changed who is in it or what is said about them.
  const [peopleVersion, bumpPeople] = useReducer(n => n + 1, 0);
  const { detail, loading, error, fetchDetail, refreshDetail, riskData } = useContextDetail(authFetch, contextId, refreshKey, onCacheData);
  const m = useContextMembers(authFetch, contextId, refreshKey, { enabled: listsMembers(detail?.attributes) });
  // The unit's saved workbench investigations: the count on the workbench button and the Proposed roles section.
  const investigations = useUnitInvestigations(contextId, opensWorkbench(analyst, knowledge, detail?.attributes));

  // The standalone page carries the unit's name in the browser tab.
  usePageTitle(pageTitleOf(embedded, detail));

  // Embedded, the page has no Close of its own: the pane beside it selects.
  const close = embedded ? undefined : onClose;
  if (loading || error || !detail?.attributes) {
    return <DetailStatus loading={loading} error={error} onRetry={fetchDetail} onClose={close} />;
  }

  const attrs = detail.attributes;
  const subContexts = detail.subContexts || [];
  const profile = profileFor(attrs.contextCategory);
  const { editable, membersEditable } = contextPageView({ analyst, attrs });
  const refreshAll = () => { m.fetchMembers(); fetchDetail(); bumpPeople(); onEdited?.(); };
  // A claim decision may change the members' facts and the context itself (an
  // alias, a property, the description): both re-read, the page stays put.
  const afterDecision = () => { m.fetchMembers(); refreshDetail(); bumpPeople(); };

  async function onAddSubUnit() {
    if (await promptAndAddSubUnit(dialog, authFetch, attrs)) { fetchDetail(); onEdited?.(); }
  }

  const members = {
    contextId, attrs, authFetch, canEditMembers: membersEditable, pageSize: MEMBER_PAGE_SIZE, onMembersChanged: refreshAll, onOpenDetail: openEntity,
    includeDescendants: m.includeDescendants, onIncludeDescendantsChange: m.setIncludeDescendants,
    memberSearch: m.memberSearch, onMemberSearchChange: m.setMemberSearch, members: m.members, memberTotal: m.memberTotal,
    membersLoading: m.membersLoading, membersError: m.membersError, memberPage: m.memberPage, onMemberPageChange: m.setMemberPage,
  };

  return (
    <WithClaims contextId={contextId} profile={profile} onDecided={afterDecision}>
      <div className="max-w-7xl mx-auto space-y-4">
        <ContextDetailHeader attrs={attrs} onOpenDetail={openEntity} addInformation={!!profile && analyst}
          onOpenWorkbench={workbenchOpener({ analyst, knowledge, attrs, openEntity })} proposedCount={proposalCount(investigations)}
          {...headerActions({ analyst, editable, embedded: embedded && !sharedView, attrs, onClose: close, onOpenAsPage, onEdit: () => setEditing(true), onAddSubUnit })}>
          <WhoAnswers profile={profile} attrs={attrs} onOpenDetail={openEntity} onRolesChanged={bumpPeople} />
        </ContextDetailHeader>
        <UploadProvenance attrs={attrs} />

        {editing && (
          <ContextEditModal
            contextId={contextId}
            attrs={attrs}
            onUpdated={() => { setEditing(false); fetchDetail(); onEdited?.(); }}
            onDeleted={() => { setEditing(false); onClose?.(); }}
            onClose={() => setEditing(false)}
          />
        )}

        <PageBody profile={profile} contextId={contextId} attrs={attrs} subContexts={subContexts} analyst={analyst}
          membersEditable={membersEditable} openEntity={openEntity} onOpenDetail={onOpenDetail} peopleVersion={peopleVersion}
          onMembersChanged={refreshAll} members={members}
          proposals={investigations} onOpenRole={workbenchOpener({ analyst, knowledge, attrs, openEntity, role: true })} />
        <AnalystFoot analyst={analyst} contextId={contextId} authFetch={authFetch} onOpenDetail={openEntity}
          riskData={riskShown(features, riskData) ? riskData : null} />
      </div>
    </WithClaims>
  );
}

// Who answers for a unit or an application, under the name (ContextPeople, in
// the profile's words); nothing for any other context.
function WhoAnswers({ profile, attrs, onOpenDetail, onRolesChanged }) {
  if (!profile) return null;
  return (
    <ContextPeople attrs={attrs} onOpenDetail={onOpenDetail} heading={null} accountableLabel={profile.accountableLabel}
      noun={profile.noun} suggest onRolesChanged={onRolesChanged} />
  );
}

// A unit's or an application's sections, or the generic page's.
function PageBody({ profile, ...props }) {
  if (profile) return <ProfileBody profile={profile} {...props} />;
  return <GenericBody attrs={props.attrs} analyst={props.analyst} subContexts={props.subContexts} members={props.members} />;
}

// The analyst's foot of the page: the Timeline, the Diff, and the Risk score when there is one.
function AnalystFoot({ analyst, contextId, authFetch, onOpenDetail, riskData }) {
  if (!analyst) return null;
  return (
    <>
      <TimelineSection contextId={contextId} authFetch={authFetch} onOpenDetail={onOpenDetail} />
      <DiffSection contextId={contextId} authFetch={authFetch} onOpenDetail={onOpenDetail} />
      <RiskSection contextId={contextId} riskData={riskData} authFetch={authFetch} />
    </>
  );
}

// A context without a template: its description, its details, its sub-units and members.
function GenericBody({ attrs, analyst, subContexts, members }) {
  return (
    <>
      {attrs.description && (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-6 py-3 text-sm text-gray-700 dark:text-gray-300">{attrs.description}</div>
      )}
      <ContextDetails key={attrs.id} attrs={attrs} framed analyst={analyst} />
      <ContextRelationshipsTab subContexts={subContexts} {...members} />
    </>
  );
}

// The claims of a unit or an application, for the whole page; anything else has none.
function WithClaims({ contextId, profile, onDecided, children }) {
  if (!profile) return children;
  return <ClaimsProvider contextId={contextId} onDecided={onDecided}>{children}</ClaimsProvider>;
}

// An analyst holds data.write.contexts outside a shared read-only view; every
// other reader gets the business view.
function useIsAnalyst() {
  const canWrite = useHasPermission('data.write.contexts');
  const sharedView = useIsSharedView();
  return canWrite && !sharedView;
}

// A read-only shell links nowhere; elsewhere the shell's own handler.
function linkTarget(sharedView, onOpenDetail) {
  return sharedView ? undefined : onOpenDetail;
}

// The standalone page carries the unit's name in the browser tab; embedded, none.
function pageTitleOf(embedded, detail) {
  return embedded ? null : detail?.attributes?.displayName;
}

// An analyst on an organizational unit has its Authorization workbench — while
// organisation knowledge is on (useOrgKnowledge).
function opensWorkbench(analyst, knowledge, attrs) {
  return !!analyst && !!knowledge && attrs?.contextCategory === 'OrganizationalUnit';
}

// An analyst opens an organizational unit's Authorization workbench as its own tab;
// `role`: the opener takes (investigationId, proposalId) and opens on that saved proposed role.
function workbenchOpener({ analyst, knowledge, attrs, openEntity, role = false }) {
  if (!openEntity || !opensWorkbench(analyst, knowledge, attrs)) return undefined;
  const title = `Workbench: ${attrs.displayName}`;
  if (role) return (investigationId, proposalId) => openEntity('workbench', workbenchRouteId(attrs.id, investigationId, proposalId), title);
  return () => openEntity('workbench', attrs.id, title);
}

// The Risk section shows when the feature is on and the context has a score.
function riskShown(features, riskData) {
  return !!features.riskScoring && riskData?.riskScore != null;
}

// The header's actions for this reader: Back to Contexts for the analyst on
// the standalone page (a business reader gets no way out to the app), Open as
// page when embedded, Edit and Add sub-unit where edits last, and Adjust tree
// for the analyst (the API says whether this unit's tree can be adjusted).
function headerActions({ analyst, editable, embedded, attrs, onClose, onOpenAsPage, onEdit, onAddSubUnit }) {
  return {
    canAdjustTree: analyst,
    onClose: analyst ? onClose : undefined,
    onOpenAsPage: embedded ? () => onOpenAsPage?.(attrs) : undefined,
    onEdit: editable ? onEdit : undefined,
    onAddSubUnit: editable ? onAddSubUnit : undefined,
  };
}

// Sets document.title while the page shows `title`, restoring the previous
// one when it goes away. Nothing happens for a null title (embedded).
function usePageTitle(title) {
  useEffect(() => {
    if (!title) return undefined;
    const previous = document.title;
    document.title = title;
    return () => { document.title = previous; };
  }, [title]);
}

// The page while it cannot show a context: loading, failed (with Retry), or
// not found. Close only where the page has one (not when embedded).
function DetailStatus({ loading, error, onRetry, onClose }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500 dark:text-gray-400">Loading context details...</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-6 max-w-md mx-auto mt-12">
        <h2 className="text-red-800 dark:text-red-300 font-semibold text-lg">Failed to load context</h2>
        <p className="text-red-600 dark:text-red-400 mt-2 text-sm">{error}</p>
        <div className="flex gap-3 mt-3">
          <button onClick={onRetry} className="text-sm text-red-700 dark:text-red-400 underline hover:text-red-900">Retry</button>
          {onClose && <button onClick={onClose} className="text-sm text-gray-500 dark:text-gray-400 underline hover:text-gray-700 dark:hover:text-gray-300">Close</button>}
        </div>
      </div>
    );
  }
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-8 text-center text-gray-600 dark:text-gray-500 text-sm">
      Context not found.
      {onClose && <button onClick={onClose} className="ml-2 text-blue-500 dark:text-blue-400 underline hover:text-blue-700 dark:hover:text-blue-300">Close</button>}
    </div>
  );
}
