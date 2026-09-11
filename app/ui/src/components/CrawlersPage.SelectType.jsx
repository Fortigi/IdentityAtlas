// Add Crawler → Select Type, plus the Experimental badge shared with the
// configured-crawler cards.
//
// Deliberately its own file: CrawlersPage eagerly globs every crawler's
// Summary.jsx, which the test runner cannot transform (tools/crawlers/ has no
// node_modules of its own), so anything importing CrawlersPage is unmountable
// in a unit test. This module pulls only plain-JS crawler metadata.
import { selectableCrawlerTypes } from '@ui/utils/crawlerMetaRegistry';

// Marks a crawler type that is built and tested but only lightly exercised
// against real-world endpoints. Shown on the type picker and on the card of any
// configured experimental crawler, so it is never a surprise what you are running.
export function ExperimentalBadge() {
  return (
    <span
      title="Experimental — built and tested, but not yet proven against many real-world endpoints"
      className="px-2 py-0.5 bg-amber-100 text-amber-800 border border-amber-200 text-xs rounded-full dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-700"
    >
      Experimental
    </span>
  );
}

// `experimentalEnabled` is the live `experimentalCrawlers` feature flag: while it
// is off, crawler types marked experimental are not offered here at all. The same
// rule is enforced server-side in routes/jobs/configs.js — this is not the gate,
// it's the part the operator sees.
export default function SelectType({ onSelect, onCancel, experimentalEnabled }) {
  const types = selectableCrawlerTypes(experimentalEnabled);
  return (
    <div className="mb-6 p-5 bg-white border border-gray-200 rounded-lg dark:bg-gray-800 dark:border-gray-700">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold dark:text-white">Add Crawler — Select Type</h3>
        <button onClick={onCancel} className="text-gray-500 hover:text-gray-700 text-sm dark:text-gray-400 dark:hover:text-gray-200">Cancel</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {types.map(t => (
          <button
            key={t.id}
            onClick={() => t.available && onSelect(t.id)}
            disabled={!t.available}
            className={`flex flex-col items-start p-4 rounded-lg border-2 text-left transition-all ${
              t.available
                ? 'border-gray-200 hover:border-blue-400 hover:shadow-md cursor-pointer dark:border-gray-700 dark:hover:border-blue-500'
                : 'border-gray-100 opacity-50 cursor-not-allowed dark:border-gray-700'
            }`}
          >
            <span className="font-semibold text-gray-900 dark:text-white">{t.name}</span>
            <span className="text-sm text-gray-500 mt-1 dark:text-gray-400">{t.description}</span>
            <span className="mt-2 flex flex-wrap gap-1">
              {t.experimental && <ExperimentalBadge />}
              {t.comingSoon && (
                <span className="px-2 py-0.5 bg-gray-100 text-gray-500 text-xs rounded-full dark:bg-gray-700 dark:text-gray-400">Coming soon</span>
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
