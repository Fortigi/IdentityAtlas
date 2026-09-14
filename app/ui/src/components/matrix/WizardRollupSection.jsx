// The Layout step's "Roll up" section (#1202).
//
// A roll-up aggregates the subject axis into groups — by one attribute, or by a
// context tree — and each cell counts the subjects in a group who hold the
// access. It used to have no control in the wizard at all (only a hand-edited
// link could set it); this is its one home, with the least a roll-up needs:
// Off / By attribute / By context, the attribute or context to group by, and —
// once on — what goes in the grid.

import { useState } from 'react';
import ContextPicker from '@ui/components/contexts/ContextPicker';
import { attributeLabel, friendlyLabel } from '@ui/utils/formatters';
import { rollupModeOf } from './MatrixFilterWizard.helpers';
import { attributeOptions } from './sortStepState';
import { ChoiceCard, SegmentedControl, SectionHeading } from './wizardControls';

const MODE_OPTIONS = [
  { key: 'off',       label: 'Off' },
  { key: 'attribute', label: 'By attribute' },
  { key: 'context',   label: 'By context' },
];

const CONTENT_OPTIONS = [
  { key: 'resources-and-roles', title: 'Resources and business roles', description: 'Resources on the rows with the roll-up groups, plus a count column per business role (the default).' },
  { key: 'resources-only',      title: 'Resources only',               description: 'Resources on the rows with the roll-up groups, without the business-role columns.' },
  { key: 'roles-only',          title: 'Business roles only',          description: 'Business roles go on the rows; each cell counts the subjects in that group who hold the role. The Resources step is skipped.' },
];

const METRIC_OPTIONS = [
  { key: 'count',   title: 'Count (#)',      description: 'The number of subjects in the group who hold it (the default).' },
  { key: 'percent', title: 'Percentage (%)', description: 'The share of the group that holds it — e.g. 8 of 10 in a department shows as 80%.' },
];

const SELECT = 'w-full max-w-md border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600';

function rollupName(rollup) {
  return attributeLabel(rollup) || friendlyLabel(String(rollup).replace(/^ext\./, ''));
}

export default function WizardRollupSection({ filter, columns, contextMeta, onModeChange, onChange, onContextResolved }) {
  const mode = rollupModeOf(filter);
  const [pickerOpen, setPickerOpen] = useState(false);
  const options = attributeOptions(columns);
  const context = filter.rollupContextId ? contextMeta.get(filter.rollupContextId) : null;

  const chooseMode = (next) => {
    onModeChange(next, options[0] || null);
    if (next === 'context' && !filter.rollupContextId) setPickerOpen(true);
  };

  return (
    <section aria-label="Roll up">
      <SectionHeading hint="Aggregate the subjects into groups; each cell counts the subjects in a group who hold the access.">
        Roll up
      </SectionHeading>
      <SegmentedControl label="Roll up" options={MODE_OPTIONS} value={mode} onChange={chooseMode} />

      {mode === 'attribute' && (
        <div className="mt-2">
          <label htmlFor="wizard-rollup-attribute" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Roll up by attribute</label>
          <select
            id="wizard-rollup-attribute"
            value={filter.rollup || ''}
            onChange={(e) => onChange({ rollup: e.target.value || null })}
            className={SELECT}
          >
            {filter.rollup && !options.includes(filter.rollup) && <option value={filter.rollup}>{rollupName(filter.rollup)}</option>}
            {options.map(o => <option key={o} value={o}>{attributeLabel(o) || o}</option>)}
          </select>
        </div>
      )}

      {mode === 'context' && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="text-gray-700 dark:text-gray-300">
            {filter.rollupContextId
              ? <>Rolled up by <span className="font-semibold">{context?.displayName || filter.rollupContextId.slice(0, 8)}</span></>
              : 'Pick the context tree to roll up by.'}
          </span>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="rounded border border-gray-200 px-2 py-0.5 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700/50"
          >
            {filter.rollupContextId ? 'Change context…' : 'Pick a context…'}
          </button>
        </div>
      )}

      {mode !== 'off' && (
        <RollupContentOptions
          rollupContent={filter.rollupContent}
          rollupMetric={filter.rollupMetric}
          onChange={(rollupContent) => onChange({ rollupContent })}
          onMetricChange={(rollupMetric) => onChange({ rollupMetric })}
        />
      )}

      <ContextPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        value={filter.rollupContextId}
        targetTypes={['Identity', 'Principal']}
        onPick={(node) => {
          onChange({ rollupContextId: node.id, rollupPath: [], rollupExpanded: [] });
          onContextResolved(node);
          setPickerOpen(false);
        }}
        title="Roll up by a context"
        subtitle="Each node of the tree becomes a group; unfold a group in the matrix to see the next level."
      />
    </section>
  );
}

// What a roll-up puts in the grid, and how each cell reads.
export function RollupContentOptions({ rollupContent, rollupMetric, onChange, onMetricChange }) {
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <OptionColumn heading="Roll-up content" options={CONTENT_OPTIONS} value={rollupContent || 'resources-and-roles'} onChange={onChange} />
      <OptionColumn heading="Cell value" options={METRIC_OPTIONS} value={rollupMetric || 'count'} onChange={onMetricChange} />
    </div>
  );
}

function OptionColumn({ heading, options, value, onChange }) {
  return (
    <div>
      <h5 className="text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1">{heading}</h5>
      <div className="space-y-2">
        {options.map(o => (
          <ChoiceCard key={o.key} active={value === o.key} onClick={() => onChange(o.key)} title={o.title} description={o.description} />
        ))}
      </div>
    </div>
  );
}
