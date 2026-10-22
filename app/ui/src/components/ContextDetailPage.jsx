import { useState, useEffect } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import RiskScoreSection from './RiskScoreSection';
import ContextDetailHeader from './ContextDetailHeader';
import ContextProfile from './contexts/profiles/ContextProfile';
import { profileFor } from './contexts/profiles/profiles';
import ContextDetails from './contexts/ContextDetails';
import ContextEditModal from './contexts/ContextEditModal';
import ContextRelationshipsTab from './ContextRelationshipsTab';
import TabBar from './TabBar';
import EntityTimeline from './EntityTimeline';
import useTimeline from '@ui/hooks/useTimeline';
import useFeatures from '@ui/hooks/useFeatures';
import { useHasPermission } from '@ui/auth/usePermissions';
import { useIsSharedView } from '@ui/contexts/SharedViewContext';
import { useDialog } from '@ui/components/dialogContext';
import { promptAndAddSubUnit } from './contexts/addSubUnit';
import { useContextMembers, MEMBER_PAGE_SIZE } from './contexts/useContextMembers';
import { useContextDetail, contextPageView } from './contexts/useContextDetail';

// ─── Context Detail Page ──────────────────────────────────────────────────────
// One page, two readers (decided 2026-10-20, permission-driven):
//   business view  no data.write.contexts (or a shared read-only view): the
//                  name and one sentence on what it is, the people who answer
//                  for it, the facts, the actions, the sub-units and members.
//                  No Edit, no Timeline, no raw classification, no member
//                  edits. Standalone, the app shell hides its navigation too
//                  (AppHeader) — the breadcrumb is the way around.
//   analyst view   with it (auth off counts): the same page plus Edit, Add
//                  sub-unit, the raw values under More details, the Timeline
//                  and Risk tabs, and an "Edit members" mode on a context
//                  created here (the only kind whose member edits last).
// Loaded via /api/contexts/:id. Standalone, document.title is the unit name.
//
// `embedded`: rendered inside the Contexts page's right pane — no close
// button (onClose then only runs after a delete), an "Open as page" button
// (onOpenAsPage(attrs)) instead. `refreshKey` re-reads the context when the
// tree beside it changed it; `onEdited` tells the page an edit here did.

export default function ContextDetailPage({ contextId, onCacheData, onClose, onOpenDetail, embedded = false, onOpenAsPage, refreshKey, onEdited }) {
  const { authFetch } = useAuth();
  const features = useFeatures();
  const dialog = useDialog();
  const canWrite = useHasPermission('data.write.contexts');
  const sharedView = useIsSharedView();
  const analyst = canWrite && !sharedView;
  const [editing, setEditing] = useState(false);
  const [activeTab, setActiveTab] = useState('members');
  const [timelineDays, setTimelineDays] = useState(90);
  const { detail, loading, error, fetchDetail, riskData } = useContextDetail(authFetch, contextId, refreshKey, onCacheData);
  const m = useContextMembers(authFetch, contextId, refreshKey);

  const timeline = useTimeline('context', contextId, authFetch, {
    sinceDays: timelineDays,
    enabled: analyst && activeTab === 'timeline',
  });

  // The standalone page carries the unit's name in the browser tab.
  usePageTitle(embedded ? null : detail?.attributes?.displayName);

  // ─── Render ────────────────────────────────────────────────────────

  // Embedded, the page has no Close of its own: the pane beside it selects.
  const close = embedded ? undefined : onClose;
  if (loading || error || !detail?.attributes) {
    return <DetailStatus loading={loading} error={error} onRetry={fetchDetail} onClose={close} />;
  }

  const attrs = detail.attributes;
  const subContexts = detail.subContexts || [];
  const { editable, membersEditable, tabs, shownTab } = contextPageView({
    analyst, attrs, activeTab, memberTotal: m.memberTotal, hasRisk: !!features.riskScoring && riskData?.riskScore != null,
  });
  const sectionIds = { members: `context-members-${contextId}`, subUnits: `context-sub-units-${contextId}` };
  const refreshAll = () => { m.fetchMembers(); fetchDetail(); onEdited?.(); };

  // A count in the facts card goes to the list it counts.
  function showSection(sectionId) {
    setActiveTab('members');
    requestAnimationFrame(() => document.getElementById(sectionId)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }));
  }

  async function onAddSubUnit() {
    if (await promptAndAddSubUnit(dialog, authFetch, attrs)) { fetchDetail(); onEdited?.(); }
  }

  // One render function per tab; only the active one runs.
  const panels = {
    members: () => (
      <ContextRelationshipsTab
        subContexts={subContexts}
        sectionIds={sectionIds}
        contextId={contextId}
        attrs={attrs}
        canEditMembers={membersEditable}
        includeDescendants={m.includeDescendants}
        onIncludeDescendantsChange={m.setIncludeDescendants}
        memberSearch={m.memberSearch}
        onMemberSearchChange={m.setMemberSearch}
        members={m.members}
        memberTotal={m.memberTotal}
        membersLoading={m.membersLoading}
        membersError={m.membersError}
        memberPage={m.memberPage}
        onMemberPageChange={m.setMemberPage}
        pageSize={MEMBER_PAGE_SIZE}
        authFetch={authFetch}
        onMembersChanged={refreshAll}
        onOpenDetail={onOpenDetail}
      />
    ),

    timeline: () => (
      <EntityTimeline
        events={timeline.events}
        loading={timeline.loading}
        sinceDays={timelineDays}
        onSinceDaysChange={setTimelineDays}
        onOpenDetail={onOpenDetail}
        hideFields={TIMELINE_HIDDEN_FIELDS}
      />
    ),

    risk: () => riskData && <RiskScoreSection attributes={riskData} entityType="contexts" entityId={contextId} authFetch={authFetch} />,
  };

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <DetailTop
        contextId={contextId}
        attrs={attrs}
        subContexts={subContexts}
        analyst={analyst}
        {...headerActions({ analyst, editable, embedded, attrs, onClose: close, onOpenAsPage, onEdit: () => setEditing(true), onAddSubUnit })}
        onOpenDetail={onOpenDetail}
        onShowMembers={() => showSection(sectionIds.members)}
        onShowSubUnits={() => showSection(sectionIds.subUnits)}
      />

      {editing && (
        <ContextEditModal
          contextId={contextId}
          attrs={attrs}
          onUpdated={() => { setEditing(false); fetchDetail(); onEdited?.(); }}
          onDeleted={() => { setEditing(false); onClose?.(); }}
          onClose={() => setEditing(false)}
        />
      )}

      {tabs && <TabBar tabs={tabs} active={activeTab} onChange={setActiveTab} />}

      <div className="mt-4 space-y-4">
        {panels[shownTab]?.()}
      </div>
    </div>
  );
}

// The header's actions for this reader: Back to Contexts for the analyst on
// the standalone page (a business reader gets no way out to the app), Open as
// page when embedded, Edit and Add sub-unit where edits last.
function headerActions({ analyst, editable, embedded, attrs, onClose, onOpenAsPage, onEdit, onAddSubUnit }) {
  return {
    onClose: analyst ? onClose : undefined,
    onOpenAsPage: embedded ? () => onOpenAsPage?.(attrs) : undefined,
    onEdit: editable ? onEdit : undefined,
    onAddSubUnit: editable ? onAddSubUnit : undefined,
  };
}

// Attributes whose changes mean nothing to a reader of the timeline.
const TIMELINE_HIDDEN_FIELDS = ['lastCalculatedAt', 'SysStartTime', 'SysEndTime'];

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

// Header, description and — for organisational units and applications — the
// template's profile (facts, variants, workflows), with the remaining
// attributes (More details) at the foot of its facts. Tags, segments and the
// rest keep the generic page, with More details as a card of its own.
function DetailTop({ contextId, attrs, subContexts, analyst, onShowMembers, onShowSubUnits, ...headerProps }) {
  const profile = profileFor(attrs.contextCategory);
  return (
    <>
      <ContextDetailHeader attrs={attrs} {...headerProps} />
      {attrs.description && (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-6 py-3 text-sm text-gray-700 dark:text-gray-300">{attrs.description}</div>
      )}
      {profile
        ? <ContextProfile key={contextId} profile={profile} attrs={attrs} subContexts={subContexts} onOpenDetail={headerProps.onOpenDetail}
            analyst={analyst} onShowMembers={onShowMembers} onShowSubUnits={onShowSubUnits} />
        : <ContextDetails key={contextId} attrs={attrs} framed analyst={analyst} />}
    </>
  );
}
