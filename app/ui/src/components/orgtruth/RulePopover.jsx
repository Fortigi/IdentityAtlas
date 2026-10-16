// Organisation → Model → Link rules: the small editor that opens when a new
// relation is drawn on the canvas or an existing line is clicked. It edits
// ONE rule: its signals (match type + weight, on the line's field) and its
// threshold; Add/Save hands the rule back, Remove asks the card to drop it.
// Every edit is a linkRulesDraft.js function.
//
// Props: { mode: 'new' | 'edit', rule, error, onChange(rule), onSubmit(),
//          onRemove(), onCancel() }
import { useId } from 'react';
import Select from '@ui/components/inputs/Select';
import {
  SIGNAL_TYPES, ruleLabel, updateRuleSignal, addRuleSignal, removeRuleSignal, setRuleThreshold, viaLabel,
} from './linkRulesDraft';
import { INPUT, SMALL_BUTTON, InlineError } from './orgUi';

const PRIMARY = 'px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600';
const DANGER = 'px-3 py-1.5 text-sm rounded border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/30';

function SignalRow({ rule, j, onChange }) {
  const s = rule.signals[j];
  const n = j + 1;
  return (
    <li className="flex flex-wrap items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
      <Select aria-label={`Match type ${n}`} value={s.type} className={INPUT}
        onChange={e => onChange(updateRuleSignal(rule, j, { type: e.target.value }))}>
        {SIGNAL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
      </Select>
      <input type="number" min={1} max={100} aria-label={`Weight ${n}`} value={s.weight} className={`${INPUT} w-20`}
        onChange={e => onChange(updateRuleSignal(rule, j, { weight: e.target.value }))} />
      <span>on {viaLabel(s.targetField)}</span>
      <button type="button" className={SMALL_BUTTON} aria-label={`Remove signal ${n}`} disabled={rule.signals.length <= 1}
        onClick={() => onChange(removeRuleSignal(rule, j))}>
        Remove
      </button>
    </li>
  );
}

export default function RulePopover({ mode, rule, error, onChange, onSubmit, onRemove, onCancel }) {
  const thresholdId = useId();
  const title = mode === 'new' ? 'New link' : 'Edit link';
  return (
    <div
      role="dialog"
      aria-label={title}
      className="mt-3 space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-700 dark:bg-blue-900/20"
      onKeyDown={e => { if (e.key === 'Escape') onCancel(); }}
    >
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}: {ruleLabel(rule)}</p>
      <InlineError message={error} />
      <ul className="space-y-2" aria-label="Signals">
        {rule.signals.map((s, j) => <SignalRow key={`${j}:${s.targetField}`} rule={rule} j={j} onChange={onChange} />)}
      </ul>
      <button type="button" className={SMALL_BUTTON} onClick={() => onChange(addRuleSignal(rule))}>Add signal</button>
      <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <label htmlFor={thresholdId}>Threshold</label>
        <input id={thresholdId} type="number" min={0} max={100} value={rule.threshold} className={`${INPUT} w-20`}
          onChange={e => onChange(setRuleThreshold(rule, e.target.value))} />
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={PRIMARY} onClick={onSubmit}>{mode === 'new' ? 'Add' : 'Save'}</button>
        {mode === 'edit' && <button type="button" className={DANGER} onClick={onRemove}>Remove link</button>}
        <button type="button" className={SMALL_BUTTON} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
