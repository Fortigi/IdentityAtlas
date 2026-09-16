// Admin → Experimental.
//
// One tab for everything that is built and tested but has not yet had much
// exposure to real-world data. Three flags today:
//   • Experimental crawlers — whether crawler types marked `experimental: true`
//     in their CrawlerMeta.js / crawler.json are offered in Add Crawler.
//   • Matrix sharing (#1166) — whether analysts can share a matrix with named
//     colleagues, and whether links already sent still open.
//   • Custom reports — whether analysts can build, save and run their own reports,
//     and describe them in plain language to the local model (a separate container).
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

// Matrix sharing reaches people outside the analyst team, so it is off until an
// operator switches it on. Off hides every sharing control and the Shared
// Matrices tab, and the API refuses the share endpoints — resolve included, so
// links that were already sent stop opening. Nothing is deleted: switching it
// back on restores the shares and their usage history.
function MatrixSharingCard({ features }) {
  const { toggle, toggling, error } = useFeatureToggle('matrixSharing');
  const enabled = features?.matrixSharing === true;
  return (
    <FeatureToggleCard
      title="Matrix sharing"
      enabled={enabled}
      busy={toggling}
      disabled={features == null}
      onToggle={() => { if (features) toggle(!enabled); }}
      toggleTitle={enabled ? 'Disable matrix sharing' : 'Enable matrix sharing'}
    >
      <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
        Lets users with the <span className="font-medium">Create matrix share links</span> permission share a
        matrix with named colleagues from the wizard's <span className="font-medium">Share</span> step or the
        matrix bar's <span className="font-medium">Share…</span>, and manage those links under
        <span className="font-medium"> Admin → Shared Matrices</span>. Turning this off hides all of that and
        stops existing share links from opening; the shares themselves are kept, so turning it back on restores them.
      </p>
      {error && (
        <div className="mt-3 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded text-sm text-red-700 dark:text-red-300">{error}</div>
      )}
    </FeatureToggleCard>
  );
}

// `features` and `version` are passed down from App.jsx, which already fetches
// both once and re-fetches features on navigation. Fetching them here instead
// would mean two more calls against the public 30-req/min rate limiter every time
// this tab is opened, and a 429 would render the switch as Disabled when it isn't.
// Custom reports need an extra container (the local model server) to be deployed
// before the "describe it" half works, and the reports themselves are new, so the
// whole feature is off until an operator switches it on. Off hides the builder and
// stops saved reports being listed; nothing is deleted.
function CustomReportsCard({ features }) {
  const { toggle, toggling, error } = useFeatureToggle('customReports');
  const enabled = features?.customReports === true;
  return (
    <FeatureToggleCard
      title="Custom reports"
      enabled={enabled}
      busy={toggling}
      disabled={features == null}
      onToggle={() => { if (features) toggle(!enabled); }}
      toggleTitle={enabled ? 'Disable custom reports' : 'Enable custom reports'}
    >
      <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
        Lets analysts build their own reports on the <span className="font-medium">Reports</span> tab — by hand, or
        by describing them in plain language to a model running on this deployment (see
        <span className="font-medium"> Admin → LLM</span> for its status). Turning this off hides the builder and
        stops saved reports from being listed or run; the saved reports themselves are kept.
      </p>
      {error && (
        <div className="mt-3 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded text-sm text-red-700 dark:text-red-300">{error}</div>
      )}
    </FeatureToggleCard>
  );
}

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

      <MatrixSharingCard features={features} />
      <CustomReportsCard features={features} />
    </div>
  );
}
