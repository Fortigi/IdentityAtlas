// Admin → Experimental.
//
// One tab for everything that is built and tested but has not yet had much
// exposure to real-world data. Today that is a single flag — Experimental
// crawlers — which decides whether crawler types marked `experimental: true`
// in their CrawlerMeta.js / crawler.json are offered in Add Crawler.
//
// Turning the flag OFF never disables a crawler that is already configured:
// it keeps its schedule, keeps running, and keeps its Experimental badge. The
// flag only governs whether a NEW one can be added — enforced server-side in
// routes/jobs/configs.js, not just here.
import useFeatureToggle from '@ui/hooks/useFeatureToggle';
import { docsUrl } from '@ui/utils/docsUrl';
import { experimentalCrawlerTypes } from '@ui/utils/crawlerMetaRegistry';
import { FeatureToggleCard } from './adminUi';

const EXPERIMENTAL_DOCS_PATH = '/reference/experimental-features/';

function CrawlerList({ types }) {
  if (!types.length) {
    return (
      <p className="mt-3 text-sm text-gray-600 dark:text-gray-400 italic">
        This build ships no experimental crawlers.
      </p>
    );
  }
  return (
    <ul className="mt-3 space-y-2">
      {types.map(t => (
        <li key={t.id} className="text-sm">
          <span className="font-medium text-gray-900 dark:text-white">{t.name}</span>
          <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">{t.id}</span>
          <p className="text-sm text-gray-600 dark:text-gray-400">{t.description}</p>
        </li>
      ))}
    </ul>
  );
}

// `features` and `version` are passed down from App.jsx, which already fetches
// both once and re-fetches features on navigation. Fetching them here instead
// would mean two more calls against the public 30-req/min rate limiter every time
// this tab is opened, and a 429 would render the switch as Disabled when it isn't.
export default function ExperimentalFeaturesSection({ features, version }) {
  const { toggle, toggling, error } = useFeatureToggle('experimentalCrawlers');

  const enabled = features?.experimentalCrawlers === true;
  const types = experimentalCrawlerTypes();

  const handleToggle = () => {
    if (features) toggle(!enabled);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4">
        <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">What "experimental" means</h3>
        <p className="mt-1 text-sm text-amber-900/90 dark:text-amber-200/90">
          An experimental feature is fully built and covered by automated tests, but it has had only
          limited opportunity to prove itself against real-world systems. It is off by default so a
          production install never picks one up by accident. Once it has run against enough real
          environments it either loses the experimental label and becomes a regular feature, or it is
          removed.
        </p>
        <a
          href={docsUrl(version, EXPERIMENTAL_DOCS_PATH)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block text-sm font-medium text-blue-700 dark:text-blue-300 hover:underline"
        >
          Read more in the documentation →
        </a>
      </div>

      <FeatureToggleCard
        title="Experimental crawlers"
        enabled={enabled}
        busy={toggling}
        disabled={features == null}
        onToggle={handleToggle}
        toggleTitle={enabled ? 'Disable experimental crawlers' : 'Enable experimental crawlers'}
      >
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          Offers the crawler types below in <span className="font-medium">Admin → Crawlers → Add Crawler</span>.
          Turning this off does not disable an experimental crawler you already configured — it keeps its
          schedule and keeps syncing — it only stops a new one being added.
        </p>
        <CrawlerList types={types} />
        {error && (
          <div className="mt-3 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded text-sm text-red-700 dark:text-red-300">{error}</div>
        )}
      </FeatureToggleCard>
    </div>
  );
}
