// Step 2 of the Risk Profile wizard — review the generated profile JSON on the
// left and refine it through a chat transcript on the right. Each chat turn
// POSTs the full transcript; the profile updates silently while the assistant's
// reply explains what changed.
import JsonViewer from './JsonViewer';
import Spinner from './Spinner';

export default function RiskProfileRefineStep({
  llmModel, scrapedSummary, profile, transcript, refining, elapsedSec,
  chatInput, setChatInput, handleRefine, setStepIdx,
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold dark:text-white">Refine the profile</h3>
        <span className="text-xs text-gray-500 dark:text-gray-400">model: <code className="dark:text-gray-300">{llmModel}</code></span>
      </div>
      {scrapedSummary && scrapedSummary.length > 0 && (
        <div className="text-xs bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded p-2">
          <div className="font-medium mb-1 dark:text-gray-300">Scraped sources:</div>
          {scrapedSummary.map((s, i) => (
            <div key={i} className={s.ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}>
              {s.ok ? '✓' : '✗'} {s.url} {s.bytes ? `(${s.bytes} bytes)` : s.error || ''}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Left: profile JSON */}
        <div>
          <div className="text-xs font-medium mb-1 dark:text-gray-300">Current profile</div>
          <JsonViewer data={profile} />
        </div>
        {/* Right: chat */}
        <div className="flex flex-col">
          <div className="text-xs font-medium mb-1 dark:text-gray-300">Refinement chat</div>
          <div className="flex-1 border border-gray-200 dark:border-gray-600 rounded p-2 bg-white dark:bg-gray-800 max-h-96 overflow-auto space-y-2">
            {transcript.length === 0 && (
              <div className="text-xs text-gray-500 dark:text-gray-400">Ask the AI to adjust anything or ask a question: "drop NIS2 — we're US-only", "what software does this org use?", "add critical role for Customs Officer"…</div>
            )}
            {transcript.map((m, i) => (
              <div key={i} className={`text-xs ${m.role === 'user' ? 'text-gray-900 dark:text-gray-200' : 'text-blue-700 dark:text-blue-400'}`}>
                <span className="font-semibold">{m.role === 'user' ? 'You' : 'AI'}:</span> {m.content}
              </div>
            ))}
            {refining && (
              <div className="text-xs text-blue-700 dark:text-blue-400 flex items-center gap-2">
                <Spinner className="h-3 w-3" />
                <span className="font-semibold">AI:</span> <em>thinking… ({elapsedSec}s)</em>
              </div>
            )}
          </div>
          <div className="flex gap-2 mt-2">
            <input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleRefine()} disabled={refining} placeholder="Ask for a change or a question…" className="flex-1 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500" />
            <button onClick={handleRefine} disabled={!chatInput.trim() || refining} className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-600">
              {refining ? `${elapsedSec}s` : 'Send'}
            </button>
          </div>
        </div>
      </div>

      <div className="flex justify-between pt-2">
        <button onClick={() => setStepIdx(0)} className="px-4 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded dark:text-gray-300 dark:hover:bg-gray-700">← Back</button>
        <button onClick={() => setStepIdx(2)} className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">Looks good — save →</button>
      </div>
    </div>
  );
}
