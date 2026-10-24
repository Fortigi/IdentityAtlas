import UnitPanel from './UnitPanel';
import AttentionPanel from './AttentionPanel';
import AdjustmentsPanel from './AdjustmentsPanel';
import { liveAdjustments } from './adjustTree.helpers';

// The right-hand side of the Adjust tree screen: three tabs — the selected
// Unit, Needs attention (count) and Adjustments (count of the changes still
// in force) — and the panel of the active one.

const TAB_BASE = 'border-b-2 px-3 pb-2 pt-2.5 text-sm';

function Badge({ count, warn }) {
  const tone = warn && count > 0
    ? 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
    : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';
  return <span className={`rounded-full px-1.5 text-xs tabular-nums ${tone}`}>{count}</span>;
}

export default function AdjustTreeSidePanel({ tab, onTab, unit, data, treeKey, editable, actions }) {
  const { tree, adjustments, attention, version } = data;
  const tabs = [
    { key: 'unit', label: 'Unit' },
    { key: 'attention', label: 'Needs attention', badge: <Badge count={attention.length} warn /> },
    { key: 'log', label: 'Adjustments', badge: <Badge count={liveAdjustments(adjustments).length} /> },
  ];
  return (
    <section aria-label="Details" className="min-w-0 rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div role="tablist" aria-label="Details" className="flex flex-wrap border-b border-gray-200 px-2 dark:border-gray-700">
        {tabs.map(t => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => onTab(t.key)}
            className={`${TAB_BASE} ${tab === t.key
              ? 'border-blue-600 font-semibold text-gray-900 dark:border-blue-400 dark:text-white'
              : 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'}`}>
            {t.label}{t.badge && ' '}{t.badge}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="p-4">
        {tab === 'unit' && (unit
          ? <UnitPanel key={unit.id} unit={unit} units={tree.units} treeKey={treeKey} targetType={tree.targetType}
              adjustments={adjustments} editable={editable} version={version} onPost={actions.post} onGroup={actions.group} />
          : <p className="text-sm text-gray-600 dark:text-gray-400">Pick a unit in the tree.</p>)}
        {tab === 'attention' && <AttentionPanel items={attention} editable={editable} onAction={actions.attention} />}
        {tab === 'log' && (
          <AdjustmentsPanel adjustments={adjustments} editable={editable}
            onUndo={actions.undo} onRedo={actions.redo} onFollow={actions.follow} />
        )}
      </div>
    </section>
  );
}
