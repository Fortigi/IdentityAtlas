// Step 1 of the Risk Profile wizard — the "tell us about the organisation"
// form: domain, org name, free-text hints, and an optional list of internal
// URLs to scrape. "Generate profile" kicks off the LLM research call.
import RiskProfileProgressPanel from './RiskProfileProgressPanel';

const INPUT_CLS = 'w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500';

export default function RiskProfileSourcesStep({
  domain, setDomain, orgName, setOrgName, hints, setHints,
  urls, addUrl, updateUrl, removeUrl, credList,
  onClose, handleGenerate, generating, elapsedSec, genError,
}) {
  const urlCount = urls.filter(u => u.url).length;
  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold dark:text-white">Tell us about the organisation</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium mb-1 dark:text-gray-300">Domain *</label>
          <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="example.com" className={INPUT_CLS} />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1 dark:text-gray-300">Organisation name (optional)</label>
          <input value={orgName} onChange={e => setOrgName(e.target.value)} placeholder="Acme Corp" className={INPUT_CLS} />
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium mb-1 dark:text-gray-300">Free-text hints (optional)</label>
        <textarea value={hints} onChange={e => setHints(e.target.value)} rows={3} placeholder="e.g. We're focused on the medical-device division. Skip the consumer products business." className={INPUT_CLS} />
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-medium dark:text-gray-300">Internal URLs to scrape (optional)</label>
          <button onClick={addUrl} className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700">+ Add URL</button>
        </div>
        {urls.length === 0 && (
          <div className="text-xs text-gray-500 dark:text-gray-400">Add wiki, ISMS, intranet pages here. Use credentials for auth-protected URLs (configure them on the Admin → LLM Settings page or below).</div>
        )}
        {urls.map((row, i) => (
          <div key={i} className="flex gap-2 mb-2">
            <input value={row.url} onChange={e => updateUrl(i, 'url', e.target.value)} placeholder="https://wiki.internal/about" className="flex-1 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded font-mono dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500" />
            <select value={row.credentialId} onChange={e => updateUrl(i, 'credentialId', e.target.value)} className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-gray-200">
              <option value="">no auth</option>
              {credList.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <button onClick={() => removeUrl(i)} className="px-2 text-red-600 dark:text-red-400">×</button>
          </div>
        ))}
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onClose} className="px-4 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded dark:text-gray-300 dark:hover:bg-gray-700">Cancel</button>
        <button onClick={handleGenerate} disabled={!domain || generating} className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-600">
          {generating ? `Generating… (${elapsedSec}s)` : 'Generate profile →'}
        </button>
      </div>
      {generating && (
        <RiskProfileProgressPanel title="The AI is researching the organisation…" elapsedSec={elapsedSec}>
          <div>1. {urlCount > 0 ? `Scraping ${urlCount} URL${urlCount === 1 ? '' : 's'}` : 'Skipping URL scraping'}</div>
          <div>2. Calling the LLM to generate the profile JSON</div>
          <div className="opacity-70 mt-2">This typically takes 20–60 seconds depending on the model. Opus/GPT-4 are slower but produce better industry-specific profiles.</div>
        </RiskProfileProgressPanel>
      )}
      {genError && <div className="text-sm text-red-700 dark:text-red-400 mt-2">{genError}</div>}
    </div>
  );
}
