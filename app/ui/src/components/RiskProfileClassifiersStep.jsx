// Step 4 of the Risk Profile wizard — generate regex classifiers from the saved
// profile, review the JSON, name the set and (optionally) activate it. Can be
// skipped entirely if the user only wanted to save the profile.
import JsonViewer from './JsonViewer';
import RiskProfileProgressPanel from './RiskProfileProgressPanel';

export default function RiskProfileClassifiersStep({
  classifiers, genClassifiers, classifierElapsedSec, classifierError,
  classifierName, setClassifierName, activateClassifier, setActivateClassifier,
  savingClassifiers, handleGenerateClassifiers, handleSaveClassifiers,
  onSaved, onClose,
}) {
  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold dark:text-white">Generate classifiers</h3>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Classifiers are regex patterns that detect high-risk principals by name.
        They're generated from the profile you just saved and applied during scoring.
      </p>
      {!classifiers && (
        <div className="flex gap-2">
          <button onClick={handleGenerateClassifiers} disabled={genClassifiers} className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-600">
            {genClassifiers ? `Generating… (${classifierElapsedSec}s)` : 'Generate classifiers'}
          </button>
          <button onClick={() => { onSaved?.(); onClose(); }} disabled={genClassifiers} className="px-4 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded dark:text-gray-300 dark:hover:bg-gray-700 disabled:opacity-50">Skip — done for now</button>
        </div>
      )}
      {genClassifiers && (
        <RiskProfileProgressPanel title="Generating regex classifiers from the profile…" elapsedSec={classifierElapsedSec}>
          <div>The LLM is translating the profile's regulations, critical roles, and known systems into regex patterns that will match high-risk principals during scoring.</div>
          <div className="opacity-70 mt-2">This typically takes 30–90 seconds with Opus — classifiers are larger than profiles. Switch to Sonnet or Haiku in Admin → LLM Settings for faster (but less nuanced) output.</div>
        </RiskProfileProgressPanel>
      )}
      {classifierError && <div className="text-sm text-red-700 dark:text-red-400 mt-2">{classifierError}</div>}
      {classifiers && (
        <>
          <JsonViewer data={classifiers} />
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium mb-1 dark:text-gray-300">Classifier set name</label>
              <input value={classifierName} onChange={e => setClassifierName(e.target.value)} className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-gray-200" />
            </div>
            <label className="flex items-center gap-2 text-sm pb-1.5 dark:text-gray-300">
              <input type="checkbox" checked={activateClassifier} onChange={e => setActivateClassifier(e.target.checked)} />
              Activate
            </label>
          </div>
          <div className="flex justify-between pt-2">
            <button onClick={handleGenerateClassifiers} disabled={genClassifiers} className="px-4 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded dark:text-gray-300 dark:hover:bg-gray-700">Regenerate</button>
            <button onClick={handleSaveClassifiers} disabled={!classifierName || savingClassifiers} className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-600">
              {savingClassifiers ? 'Saving…' : 'Save classifiers →'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
