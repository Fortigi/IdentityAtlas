// Shared schedule editor component used by Crawlers and Risk Scoring

export default function ScheduleEditor({ schedule, onChange, onRemove }) {
  const update = (field, value) => onChange({ ...schedule, [field]: value });
  return (
    <div className="p-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded mb-2">
      <div className="grid grid-cols-6 gap-2 items-end">
        <div>
          <label className="block text-xs font-medium mb-1 dark:text-gray-300">Frequency</label>
          <select value={schedule.frequency || 'daily'} onChange={e => update('frequency', e.target.value)}
            className="w-full p-2 border border-gray-200 dark:border-gray-600 rounded text-sm dark:bg-gray-700 dark:text-gray-200">
            <option value="hourly">Hourly</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </div>
        {schedule.frequency !== 'hourly' && (
          <div>
            <label className="block text-xs font-medium mb-1 dark:text-gray-300">Hour (UTC)</label>
            <select value={schedule.hour ?? 2} onChange={e => update('hour', parseInt(e.target.value, 10))}
              className="w-full p-2 border border-gray-200 dark:border-gray-600 rounded text-sm dark:bg-gray-700 dark:text-gray-200">
              {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="block text-xs font-medium mb-1 dark:text-gray-300">Minute</label>
          <select value={schedule.minute ?? 0} onChange={e => update('minute', parseInt(e.target.value, 10))}
            className="w-full p-2 border border-gray-200 dark:border-gray-600 rounded text-sm dark:bg-gray-700 dark:text-gray-200">
            {[0, 15, 30, 45].map(m => <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>)}
          </select>
        </div>
        {schedule.frequency === 'weekly' && (
          <div>
            <label className="block text-xs font-medium mb-1 dark:text-gray-300">Day</label>
            <select value={schedule.day ?? 0} onChange={e => update('day', parseInt(e.target.value, 10))}
              className="w-full p-2 border border-gray-200 dark:border-gray-600 rounded text-sm dark:bg-gray-700 dark:text-gray-200">
              {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="block text-xs font-medium mb-1 dark:text-gray-300" title="Delta = fetch only what changed since last run (fast). Full = re-fetch everything (slow). A common pattern is frequent deltas + one full run per week.">Mode</label>
          <select value={schedule.syncMode || 'delta'} onChange={e => update('syncMode', e.target.value)}
            className="w-full p-2 border border-gray-200 dark:border-gray-600 rounded text-sm dark:bg-gray-700 dark:text-gray-200">
            <option value="delta">Delta (fast)</option>
            <option value="full">Full (authoritative)</option>
          </select>
        </div>
        <button onClick={onRemove} className="px-2 py-2 text-xs bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded hover:bg-red-200 dark:hover:bg-red-900/50 self-end">Remove</button>
      </div>
    </div>
  );
}
