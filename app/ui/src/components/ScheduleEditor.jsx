// Shared schedule editor component used by Crawlers and Risk Scoring

export default function ScheduleEditor({ schedule, onChange, onRemove }) {
  const update = (field, value) => onChange({ ...schedule, [field]: value });
  return (
    <div className="p-3 bg-white border border-gray-200 rounded mb-2">
      <div className="grid grid-cols-5 gap-2 items-end">
        <div>
          <label className="block text-xs font-medium mb-1">Frequency</label>
          <select value={schedule.frequency || 'daily'} onChange={e => update('frequency', e.target.value)}
            className="w-full p-2 border border-gray-200 rounded text-sm">
            <option value="hourly">Hourly</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </div>
        {schedule.frequency !== 'hourly' && (
          <div>
            <label className="block text-xs font-medium mb-1">Hour (UTC)</label>
            <select value={schedule.hour ?? 2} onChange={e => update('hour', parseInt(e.target.value, 10))}
              className="w-full p-2 border border-gray-200 rounded text-sm">
              {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="block text-xs font-medium mb-1">Minute</label>
          <select value={schedule.minute ?? 0} onChange={e => update('minute', parseInt(e.target.value, 10))}
            className="w-full p-2 border border-gray-200 rounded text-sm">
            {[0, 15, 30, 45].map(m => <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>)}
          </select>
        </div>
        {schedule.frequency === 'weekly' && (
          <div>
            <label className="block text-xs font-medium mb-1">Day</label>
            <select value={schedule.day ?? 0} onChange={e => update('day', parseInt(e.target.value, 10))}
              className="w-full p-2 border border-gray-200 rounded text-sm">
              {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </div>
        )}
        <button onClick={onRemove} className="px-2 py-2 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200 self-end">Remove</button>
      </div>
    </div>
  );
}
