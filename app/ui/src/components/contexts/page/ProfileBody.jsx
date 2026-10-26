import { useState } from 'react';
import { useContextClaims } from '@ui/components/contexts/interviews/claimsContext';
import { openContradictions, isPersonContradiction } from '@ui/components/contexts/interviews/contradiction.helpers';
import { proposedClaims } from '@ui/components/contexts/interviews/claims.helpers';
import WhatWeKnow from '@ui/components/contexts/interviews/WhatWeKnow';
import ReviewDrawer from '@ui/components/contexts/interviews/ReviewDrawer';
import SourcesSection from '@ui/components/contexts/interviews/SourcesSection';
import ChangeRequestsPanel from '@ui/components/contexts/changeRequests/ChangeRequestsPanel';
import { useChangeRequests } from '@ui/components/contexts/changeRequests/useChangeRequests';
import PeopleSection from '@ui/components/contexts/people/PeopleSection';
import AttentionLine from '@ui/components/contexts/AttentionLine';
import { SubUnitsList, MembersPanel } from '@ui/components/ContextRelationshipsTab';

// ─── The body of a unit's or an application's page ───────────────────────
// In reading order: the analyst's attention line, People, the members as their
// source lists them when they are not people (an application's resources), What
// we know (the unit itself), Sources, Change requests, Sub-units. The Timeline and
// Risk follow (the page adds them). What we know, Sources and Change requests
// start folded to one line; the attention line opens the one its work is in and
// scrolls to it. A reader (business view, context owner) gets People, What we
// know and the sub-units: no attention line, no sources, no review.

const PEOPLE_TARGETS = new Set(['Principal', 'Identity']);

function scrollTo(id) {
  requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }));
}

export default function ProfileBody({ contextId, attrs, profile, subContexts, analyst, membersEditable, openEntity, onOpenDetail, peopleVersion, onMembersChanged, members }) {
  const ctx = useContextClaims();
  const [peopleFilter, setPeopleFilter] = useState('current');
  const [opened, setOpened] = useState({});
  const [reviewing, setReviewing] = useState(false);
  const requests = useChangeRequests(contextId, { enabled: analyst });
  const ids = { people: `people-${contextId}`, know: `what-we-know-${contextId}`, sources: `sources-${contextId}`, changes: `change-requests-${contextId}` };
  const openSection = (key) => { setOpened(o => ({ ...o, [key]: true })); scrollTo(ids[key]); };
  const fold = (key) => ({ open: !!opened[key], onOpenChange: (v) => setOpened(o => ({ ...o, [key]: v })) });

  const open = openContradictions(ctx?.contradictions);
  function decide() {
    if (open.some(isPersonContradiction)) { setPeopleFilter('decide'); scrollTo(ids.people); } else openSection('know');
  }
  const peopleMembers = PEOPLE_TARGETS.has(attrs.targetType);

  return (
    <>
      {analyst && (
        <AttentionLine toDecide={open.length} toReview={proposedClaims(ctx?.claims).length} toCorrect={requests.open.length}
          onDecide={decide} onReview={() => setReviewing(true)} onCorrect={() => openSection('changes')} />
      )}
      <PeopleSection id={ids.people} attrs={attrs} filter={peopleFilter} onFilterChange={setPeopleFilter} version={peopleVersion}
        canEditMembers={peopleMembers && membersEditable} onOpenDetail={openEntity} onMembersChanged={onMembersChanged} hideWhenEmpty={!peopleMembers} />
      {!peopleMembers && <MembersPanel {...members} title={profile.membersLabel} />}
      <WhatWeKnow id={ids.know} attrs={attrs} profile={profile} analyst={analyst} onOpenDetail={onOpenDetail} {...fold('know')} />
      {analyst && <SourcesSection id={ids.sources} contextId={contextId} {...fold('sources')} />}
      {analyst && <ChangeRequestsPanel id={ids.changes} requests={requests} {...fold('changes')} />}
      {subContexts.length > 0 && <SubUnitsList subContexts={subContexts} attrs={attrs} onOpenDetail={openEntity} />}
      {reviewing && <ReviewDrawer onClose={() => setReviewing(false)} />}
    </>
  );
}
