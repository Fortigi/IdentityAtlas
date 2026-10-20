// Shared schedule editor component used by every crawler wizard's Schedule step

import { INTERVAL_MINUTES, withFrequency } from '@ui/utils/schedules';

const SELECT_CLASS = 'w-full p-2 border border-gray-200 dark:border-gray-600 rounded text-sm dark:bg-gray-700 dark:text-gray-200';
const LABEL_CLASS = 'block text-xs font-medium mb-1 dark:text-gray-300';

export default function ScheduleEditor({ schedule, onChange, onRemove }) {
  const update = (field, value) => onChange({ ...schedule, [field]: value });
  const frequency = schedule.frequency || 'daily';
  const isInterval = frequency === 'interval';
  return (
    <div className="p-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded mb-2">
      <div className="grid grid-cols-6 gap-2 items-end">
        <div>
          <label className={LABEL_CLASS}>Frequency</label>
          <select value={frequency} onChange={e => onChange(withFrequency(schedule, e.target.value))} className={SELECT_CLASS}>
            <option value="interval">Every few minutes</option>
            <option value="hourly">Hourly</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </div>
        {isInterval && (
          <div>
            <label className={LABEL_CLASS}>Every</label>
            <select value={schedule.intervalMinutes} onChange={e => update('intervalMinutes', parseInt(e.target.value, 10))} className={SELECT_CLASS}>
              {INTERVAL_MINUTES.map(m => <option key={m} value={m}>{m} minutes</option>)}
            </select>
          </div>
        )}
        {(frequency === 'daily' || frequency === 'weekly') && (
          <div>
            <label className={LABEL_CLASS}>Hour (UTC)</label>
            <select value={schedule.hour ?? 2} onChange={e => update('hour', parseInt(e.target.value, 10))} className={SELECT_CLASS}>
              {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>)}
            </select>
          </div>
        )}
        {!isInterval && (
          <div>
            <label className={LABEL_CLASS}>Minute</label>
            <select value={schedule.minute ?? 0} onChange={e => update('minute', parseInt(e.target.value, 10))} className={SELECT_CLASS}>
              {[0, 15, 30, 45].map(m => <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>)}
            </select>
          </div>
        )}
        {frequency === 'weekly' && (
          <div>
            <label className={LABEL_CLASS}>Day</label>
            <select value={schedule.day ?? 0} onChange={e => update('day', parseInt(e.target.value, 10))} className={SELECT_CLASS}>
              {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className={LABEL_CLASS} title="Delta = fetch only what changed since last run (fast). Some crawlers refresh only part of their data on a delta — see the crawler's documentation. Full = re-fetch everything (slow). A common pattern is frequent deltas plus a full run at least once a day.">Mode</label>
          <select value={schedule.syncMode || 'delta'} onChange={e => update('syncMode', e.target.value)} className={SELECT_CLASS}>
            <option value="delta">Delta (fast)</option>
            <option value="full">Full (authoritative)</option>
          </select>
        </div>
        <button onClick={onRemove} className="px-2 py-2 text-xs bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded hover:bg-red-200 dark:hover:bg-red-900/50 self-end">Remove</button>
      </div>
    </div>
  );
}
