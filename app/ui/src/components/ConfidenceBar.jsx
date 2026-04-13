const CONFIDENCE_TOOLTIP = 'Correlation confidence — how certain the system is that the linked accounts belong to the same person.';

export default function ConfidenceBar({ confidence }) {
  if (confidence == null) {
    return (
      <div className="flex items-center gap-2" title={`${CONFIDENCE_TOOLTIP} Not yet calculated.`}>
        <div className="w-20 h-2 bg-gray-200 rounded-full" />
        <span className="text-xs font-mono text-gray-400 w-8 text-right">—%</span>
      </div>
    );
  }
  const color = confidence >= 90 ? 'bg-green-500' : confidence >= 70 ? 'bg-blue-500' : confidence >= 50 ? 'bg-yellow-500' : 'bg-orange-500';
  return (
    <div className="flex items-center gap-2" title={`${CONFIDENCE_TOOLTIP} ${confidence}%`}>
      <div className="w-20 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${confidence}%` }} />
      </div>
      <span className="text-xs font-mono text-gray-600 w-8 text-right">{confidence}%</span>
    </div>
  );
}
