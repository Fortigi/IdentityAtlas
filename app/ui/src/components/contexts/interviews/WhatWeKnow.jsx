import { useContextClaims } from './claimsContext';
import ClaimReviewList from './ClaimReviewList';
import Contradictions from './Contradictions';
import AlsoKnownAs from './AlsoKnownAs';
import FoldSection from '@ui/components/contexts/FoldSection';
import ContextDetails from '@ui/components/contexts/ContextDetails';
import UnitVariants from '@ui/components/contexts/profiles/UnitVariants';
import { useUnitVariants } from '@ui/components/contexts/profiles/useUnitVariants';
import { aliasFacts, groupConfirmed, isPersonClaim, proposedClaims, sourceLabel, whatWeKnowSummary } from './claims.helpers';

// ─── What we know — facts about the unit (or the application) itself ─────
// Its description, the properties the sources established, its other names, the
// same unit held as other kinds of member, and the remaining attributes (More
// details). Facts about people are not here: each person's sit on their row in
// People. Folded by default to one line — the start of the description, then
// "3 properties · also known as HA · 2 to review". An analyst also gets the unit's
// own claims to review and the contradictions about it (a property against the
// value the context holds); a reader is sent confirmed claims only and sees no
// review. Open or closed is the page's (`open`, `onOpenChange`): the attention
// line opens it when the work waiting is about the unit.

function Quote({ claim }) {
  return (
    <details className="text-xs text-gray-600 dark:text-gray-400">
      <summary className="cursor-pointer">{sourceLabel(claim)}</summary>
      {claim.quote && <blockquote className="mt-1 border-l-2 border-gray-300 pl-2 italic text-gray-700 dark:border-gray-600 dark:text-gray-300">{claim.quote}</blockquote>}
    </details>
  );
}

function Group({ title, children }) {
  return (
    <div>
      <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300">{title}</h4>
      {children}
    </div>
  );
}

export default function WhatWeKnow({ id, attrs, profile, analyst = false, onOpenDetail, open, onOpenChange }) {
  const ctx = useContextClaims();
  const { variants } = useUnitVariants(attrs);
  const claims = ctx?.claims || [];
  const canWrite = !!ctx?.canWrite;
  const { properties } = groupConfirmed(claims);
  const aliases = aliasFacts(attrs, claims, false).map(a => a.name);
  const toReview = canWrite ? proposedClaims(claims).filter(c => !isPersonClaim(c)) : [];
  return (
    <FoldSection id={id} title="What we know" testId="what-we-know" open={open} onOpenChange={onOpenChange}
      summary={whatWeKnowSummary({ description: attrs.description, claims, aliases, canWrite })}>
      {attrs.description && (
        <Group title="Description">
          <p className="whitespace-pre-wrap text-sm text-gray-900 dark:text-gray-200">{attrs.description}</p>
        </Group>
      )}
      {properties.length > 0 && (
        <Group title="Properties">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {properties.map(c => (
              <div key={c.id} className="contents">
                <dt className="text-gray-600 dark:text-gray-400">{c.attribute}</dt>
                <dd className="text-gray-900 dark:text-gray-200">{c.value}<Quote claim={c} /></dd>
              </div>
            ))}
          </dl>
        </Group>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm"><AlsoKnownAs attrs={attrs} /></dl>
      <UnitVariants variants={variants} onOpenDetail={onOpenDetail} label={profile.variantsLabel} />
      <Contradictions unitOnly />
      {toReview.length > 0 && <ClaimReviewList claims={toReview} decide={ctx.decide} rejectMany={ctx.rejectMany} openTranscript={ctx.openTranscript} />}
      <ContextDetails attrs={attrs} hasProfile analyst={analyst} />
    </FoldSection>
  );
}
