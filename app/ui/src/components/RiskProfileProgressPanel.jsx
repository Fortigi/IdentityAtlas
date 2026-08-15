// The blue "AI is working" panel shown while the wizard waits on a long LLM
// call (profile research in the Sources step, classifier generation in the
// Classifiers step). Renders a spinner, a bold title, an elapsed-seconds
// counter, and whatever per-step detail lines are passed as children.
import Spinner from './Spinner';

export default function RiskProfileProgressPanel({ title, elapsedSec, children }) {
  return (
    <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded text-sm">
      <div className="flex items-center gap-2 text-blue-900 dark:text-blue-300">
        <Spinner />
        <span className="font-medium">{title}</span>
        <span className="text-xs text-blue-700 dark:text-blue-400 ml-auto">{elapsedSec}s elapsed</span>
      </div>
      <div className="text-xs text-blue-700 dark:text-blue-400 mt-2 space-y-1">
        {children}
      </div>
    </div>
  );
}
