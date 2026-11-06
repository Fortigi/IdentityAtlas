import { memberKindLabel } from '@ui/utils/contextStyles';
import ContextPeople from '@ui/components/contexts/ContextPeople';
import WorkflowsArea from '@ui/components/contexts/workflows/WorkflowsArea';
import ContextDetails from '@ui/components/contexts/ContextDetails';
import UnitVariants from './UnitVariants';
import { useUnitVariants } from './useUnitVariants';
import { memberCountText } from './variants.helpers';

// The facts a templated context shows first — who answers for it (with a
// suggestion while no Accountable is set), what it holds, its sub-units, the
// same unit as other kinds of member — then the remaining attributes (More
// details), and below them the workflows that start from it. `profile` is an
// entry of profiles.js; it supplies the vocabulary. `analyst`: the reader can
// edit contexts (More details then carries the raw classification).
// onShowMembers / onShowSubUnits make the counts links to the lists below.
export default function ContextProfile({ profile, attrs, subContexts = [], onOpenDetail, analyst = false, onShowMembers, onShowSubUnits }) {
  const { variants, loading } = useUnitVariants(attrs);
  const membersLabel = profile.membersWithKind ? memberKindLabel(attrs.targetType) : profile.membersLabel;

  return (
    <>
      <section aria-label={profile.title} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-6 py-4">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{profile.title}</h3>
        <ContextPeople attrs={attrs} onOpenDetail={onOpenDetail} heading={null} accountableLabel={profile.accountableLabel} noun={profile.noun} suggest />
        <dl className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-gray-500 dark:text-gray-400">{membersLabel}</dt>
          <dd className="text-gray-900 dark:text-gray-200"><CountLink text={memberCountText(attrs, profile.noun)} onClick={onShowMembers} /></dd>
          {profile.showSubUnits && (
            <>
              <dt className="text-gray-500 dark:text-gray-400">Sub-units</dt>
              <dd className="text-gray-900 dark:text-gray-200">
                <CountLink text={String(subContexts.length)} onClick={subContexts.length > 0 ? onShowSubUnits : undefined} />
              </dd>
            </>
          )}
        </dl>
        <UnitVariants variants={variants} onOpenDetail={onOpenDetail} label={profile.variantsLabel} />
        <ContextDetails attrs={attrs} hasProfile analyst={analyst} />
      </section>
      <WorkflowsArea attrs={attrs} variants={variants} variantsLoading={loading} onOpenDetail={onOpenDetail} />
    </>
  );
}

// A count that scrolls to the list it counts, when there is one to go to.
function CountLink({ text, onClick }) {
  if (!onClick) return text;
  return (
    <button type="button" onClick={onClick} className="text-blue-700 hover:underline dark:text-blue-300">{text}</button>
  );
}
