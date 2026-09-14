// The Matrix wizard's Layout step — how the matrix reads (#1202).
//
//   Group & sort columns — the old Sort step
//   Roll up              — Off / By attribute / By context, and what goes in the grid
//   Open with            — the trends & breakdown panel and the default lens
//
// Grouping and roll-up are mutually exclusive: a roll-up's columns ARE its
// groups. Rather than hiding the grouping section the moment a roll-up is
// switched on (a layout that rearranges itself under the pointer), it stays in
// place, disabled, with the reason next to it.
//
// There is deliberately no orientation control here: swapping the axes is not
// offered from the wizard (#1202 requestor decision).

import MatrixSortStep from './MatrixSortStep';
import WizardRollupSection from './WizardRollupSection';
import { CheckboxToggle, SegmentedControl, SectionHeading } from './wizardControls';

const LENS_OPTIONS = [
  { key: 'all',       label: 'All' },
  { key: 'managed',   label: 'Governed' },
  { key: 'unmanaged', label: 'Non-governed' },
  { key: 'gaps',      label: 'Gaps' },
];

export default function WizardLayoutStep({
  filter, columns, contextMeta, rollupOn, assignmentCount,
  managed, onManagedChange, onPatch, onRollupModeChange, onContextResolved,
}) {
  return (
    <div className="space-y-5">
      <fieldset disabled={rollupOn} aria-describedby={rollupOn ? 'wizard-grouping-off' : undefined} className={rollupOn ? 'opacity-60' : ''}>
        {rollupOn && (
          <p id="wizard-grouping-off" className="mb-2 text-xs text-gray-600 dark:text-gray-400">
            Roll-up is on — the columns are the roll-up groups, so grouping and sorting don’t apply.
          </p>
        )}
        <MatrixSortStep
          sortAttributes={filter.sortAttributes}
          columns={columns}
          onChange={(sortAttributes) => onPatch({ sortAttributes })}
          foldOnLoad={filter.foldOnLoad}
          onFoldChange={(foldOnLoad) => onPatch({ foldOnLoad })}
          assignmentCount={assignmentCount}
          sortHierarchy={filter.sortHierarchy}
          onHierarchyChange={(sortHierarchy) => onPatch({ sortHierarchy })}
        />
      </fieldset>

      <div className="pt-4 border-t border-gray-100 dark:border-gray-700">
        <WizardRollupSection
          filter={filter}
          columns={columns}
          contextMeta={contextMeta}
          onModeChange={onRollupModeChange}
          onChange={onPatch}
          onContextResolved={onContextResolved}
        />
      </div>

      <section aria-label="Open with" className="pt-4 border-t border-gray-100 dark:border-gray-700 space-y-3">
        <SectionHeading>Open with</SectionHeading>
        {/* #1202: the scope-statistics panel used to sit above every matrix,
            pushing the grid down. It is reporting tooling — opt in per matrix. */}
        <CheckboxToggle
          label="Show trends & breakdown above the matrix"
          checked={!!filter.showTrends}
          onChange={(showTrends) => onPatch({ showTrends })}
        >
          Adds the scope-statistics panel: totals, the governed split and — on expand — history and a
          per-department breakdown. Off by default, so the matrix starts at the top of the page.
        </CheckboxToggle>
        <div>
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Default lens</p>
          <SegmentedControl label="Default lens" options={LENS_OPTIONS} value={managed} onChange={onManagedChange} />
          <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
            Which assignments the matrix highlights when it opens. Viewers can still switch lens in the matrix.
          </p>
        </div>
      </section>
    </div>
  );
}
