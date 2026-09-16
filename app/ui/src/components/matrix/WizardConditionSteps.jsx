// The Matrix wizard's Subjects and Resources steps (#1202).
//
// Each opens with the one choice that decides what that side of the matrix IS —
// user accounts or identities; resources alone or with business roles — and
// then narrows it with the same Include / Exclude condition lists. The two steps
// differed only in wording and in which contexts they accept, so they share one
// condition component (the duplication check caught them as two copies once).
//
// Extracted from MatrixFilterWizard.jsx, which may only shrink.

import { useState } from 'react';
import ContextPicker from '@ui/components/contexts/ContextPicker';
import { variantMeta, targetTypeMeta } from '@ui/utils/contextStyles';
import AttributePicker from './AttributePicker';
import { axisHeadings } from './MatrixFilterWizard.helpers';
import { ChoiceGroup, CheckboxToggle, Disclosure } from './wizardControls';

const ROW_TYPE_OPTIONS = [
  { key: 'principal', title: 'User accounts', description: 'One subject per account. Best for clean-up sweeps and per-account audits.' },
  { key: 'identity',  title: 'Identities',    description: 'One subject per person, across all their accounts. Best for role mining and birthright analysis.' },
];

const RESOURCE_SHAPE_OPTIONS = [
  { key: 'resources', title: 'Resources', description: 'Groups, roles, apps and sites. Business roles appear as columns of their own.' },
  { key: 'with-roles', title: 'Resources and business roles', description: 'Also give each business role a foldable row, with the resources it grants underneath it.' },
];

// ─── Subjects ──────────────────────────────────────────────────────

export function WizardSubjectsStep({ filter, onRowTypeChange, ...conditionProps }) {
  const identities = filter.rowType === 'identity';
  return (
    <div className="space-y-4">
      <ChoiceGroup
        heading={axisHeadings(filter.orientation).subjects}
        options={ROW_TYPE_OPTIONS}
        value={filter.rowType}
        onChange={onRowTypeChange}
      />
      <ConditionStep
        intro={`Narrow down the ${identities ? 'identities' : 'users'} in the matrix. Includes are AND'd; excludes negate.`}
        block={filter.subject}
        allowedTargets={identities ? ['Identity'] : ['Principal']}
        entity={identities ? 'Identity' : 'Principal'}
        includeHint={`No include filters — every ${identities ? 'identity' : 'user'} matches.`}
        {...conditionProps}
      />
    </div>
  );
}

// ─── Resources ─────────────────────────────────────────────────────

export function WizardResourcesStep({ filter, onFlagChange, ...conditionProps }) {
  return (
    <div className="space-y-4">
      <ChoiceGroup
        heading={axisHeadings(filter.orientation).resources}
        options={RESOURCE_SHAPE_OPTIONS}
        value={filter.includeBusinessRoles ? 'with-roles' : 'resources'}
        onChange={(key) => onFlagChange('includeBusinessRoles', key === 'with-roles')}
      />
      <ConditionStep
        intro="Narrow down the resources in the matrix. Includes are AND'd; excludes negate."
        block={filter.resource}
        allowedTargets={['Resource', 'System']}
        entity="Resource"
        includeHint="No include filters — every resource matches."
        {...conditionProps}
      />
      {/* Open when the option is already on, so a setting that changes the
          matrix is never hidden behind a closed disclosure. */}
      <Disclosure label="More options" defaultOpen={!!filter.includeInheritedAccess}>
        <CheckboxToggle
          label="Include inherited access"
          checked={!!filter.includeInheritedAccess}
          onChange={(v) => onFlagChange('includeInheritedAccess', v)}
        >
          Also show access inherited from higher scopes — e.g. Owner on a subscription appears as
          an <strong>Indirect</strong> grant on every resource beneath it. Computed on demand, so
          it&apos;s slower; only meaningful once you&apos;ve scoped to a set of resources above.
        </CheckboxToggle>
      </Disclosure>
    </div>
  );
}

// ─── Include / Exclude ─────────────────────────────────────────────

function ConditionStep({ intro, block, allowedTargets, entity, contextMeta, columns, onContextResolved, onAdd, onRemove, onUpdate, includeHint }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-600 dark:text-gray-400">{intro}</p>
      {[
        { title: 'Include', side: 'include', emptyHint: includeHint },
        { title: 'Exclude', side: 'exclude', emptyHint: 'No exclude filters.' },
      ].map(({ title, side, emptyHint }) => (
        <ConditionList
          key={side}
          title={title}
          conditions={block[side]}
          allowedTargets={allowedTargets}
          contextMeta={contextMeta}
          columns={columns}
          entity={entity}
          onContextResolved={onContextResolved}
          onAdd={(c) => onAdd(side, c)}
          onRemove={(idx) => onRemove(side, idx)}
          onUpdate={(idx, patch) => onUpdate(side, idx, patch)}
          emptyHint={emptyHint}
        />
      ))}
    </div>
  );
}

const ADD_BUTTON = 'text-[11px] px-2 py-0.5 rounded border border-dashed border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-gray-400 hover:text-gray-800 dark:hover:text-gray-200';

function ConditionList({ title, conditions, contextMeta, columns, entity, onContextResolved, onAdd, onRemove, onUpdate, emptyHint, allowedTargets }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attrOpen, setAttrOpen] = useState(false);

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-gray-50 dark:bg-gray-700/30 border-b border-gray-100 dark:border-gray-700">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{title}</span>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setPickerOpen(true)} className={ADD_BUTTON}>+ Context</button>
          <button type="button" onClick={() => setAttrOpen(true)} className={ADD_BUTTON}>+ Attribute</button>
        </div>
      </div>
      <div className="p-2 space-y-1.5">
        {conditions.length === 0 ? (
          <p className="text-[11px] text-gray-600 dark:text-gray-400 italic">{emptyHint}</p>
        ) : (
          conditions.map((cond, idx) => (
            <ConditionRow
              key={idx}
              cond={cond}
              contextMeta={contextMeta}
              onRemove={() => onRemove(idx)}
              onUpdate={(patch) => onUpdate(idx, patch)}
            />
          ))
        )}
      </div>

      <ContextPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        targetTypes={allowedTargets}
        onPick={(node) => {
          onAdd({ kind: 'context', contextId: node.id, includeChildren: true });
          if (node) onContextResolved(node);
          setPickerOpen(false);
        }}
        title={`Pick a context for ${title.toLowerCase()}`}
        subtitle="Resource and System contexts apply to the resource side; Identity, Principal contexts to the subject side."
      />
      {attrOpen && (
        <AttributePicker
          entity={entity}
          columns={columns}
          onPick={(field, values) => {
            onAdd({ kind: 'attribute', field, values });
            setAttrOpen(false);
          }}
          onClose={() => setAttrOpen(false)}
        />
      )}
    </div>
  );
}

const CHIP = 'inline-flex items-center gap-1 bg-slate-50 dark:bg-gray-700/50 border border-slate-200 dark:border-gray-600 rounded px-2 py-1 flex-1 min-w-0';

function RemoveButton({ onClick }) {
  return (
    <button type="button" onClick={onClick} className="text-gray-600 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400" aria-label="Remove">×</button>
  );
}

function ContextConditionRow({ cond, contextMeta, onRemove, onUpdate }) {
  const meta = contextMeta.get(cond.contextId);
  const variant = meta ? variantMeta(meta.variant) : null;
  const target = meta ? targetTypeMeta(meta.targetType) : null;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={CHIP}>
        {variant && <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${variant.dotClass}`} aria-hidden="true" />}
        <span className="text-gray-500 dark:text-gray-400 font-medium uppercase text-[10px]">Context</span>
        <span className="truncate text-gray-800 dark:text-gray-200" title={meta ? meta.displayName : cond.contextId}>
          {meta ? meta.displayName : cond.contextId.slice(0, 8)}
        </span>
        {target && <span className={`text-[9px] px-1 rounded border flex-shrink-0 ${target.badgeClass}`}>{target.label}</span>}
        <label className="inline-flex items-center gap-1 text-slate-500 dark:text-gray-400 cursor-pointer ml-auto text-[10px]">
          <input
            type="checkbox"
            checked={!!cond.includeChildren}
            onChange={() => onUpdate({ includeChildren: !cond.includeChildren })}
            className="w-3 h-3"
          />
          <span>incl. descendants</span>
        </label>
      </span>
      <RemoveButton onClick={onRemove} />
    </div>
  );
}

function ConditionRow({ cond, contextMeta, onRemove, onUpdate }) {
  if (cond.kind === 'context') {
    return <ContextConditionRow cond={cond} contextMeta={contextMeta} onRemove={onRemove} onUpdate={onUpdate} />;
  }
  if (cond.kind !== 'attribute') return null;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={CHIP}>
        <span className="text-gray-500 dark:text-gray-400 font-medium uppercase text-[10px]">{cond.field}</span>
        <span className="text-gray-600 dark:text-gray-500">in</span>
        <span className="truncate text-gray-800 dark:text-gray-200 flex-1">
          {(cond.values || []).join(', ')}
        </span>
      </span>
      <RemoveButton onClick={onRemove} />
    </div>
  );
}
