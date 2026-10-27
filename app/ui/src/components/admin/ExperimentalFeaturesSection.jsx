// Admin → Experimental.
//
// One tab for everything that is built and tested but has not yet had much
// exposure to real-world data, each behind its own flag:
//   • Experimental crawlers — whether crawler types marked `experimental: true`
//     in their CrawlerMeta.js / crawler.json are offered in Add Crawler.
//   • Matrix sharing (#1166) — whether analysts can share a matrix with named
//     colleagues, and whether links already sent still open.
//   • Custom reports — whether analysts can build, save and run their own reports,
//     and describe them in plain language to the local model (a separate container).
//   • Context assistant — the "Describe it" context builder.
// Below them, the context settings that change what a sync writes on its own
// (not experimental, but switched the same way): Accountables from source owners.
//
// Turning the crawler flag OFF never disables a crawler that is already
// configured: it keeps its schedule, keeps running, and keeps its Experimental
// badge. The flag only governs whether a NEW one can be added — enforced
// server-side in routes/jobs/configs.js, not just here.
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

// One switch for one flag of /api/features. `what` names the feature in the
// switch's tooltip ("Enable matrix sharing"). `features` and `version` are passed
// down from App.jsx, which already fetches both once and re-fetches features on
// navigation. Fetching them here instead would mean more calls against the public
// 30-req/min rate limiter every time this tab is opened, and a 429 would render
// the switch as Disabled when it isn't.
export function FlagCard({ features, name, title, what, children }) {
  const { toggle, toggling, error } = useFeatureToggle(name);
  const enabled = features?.[name] === true;
  return (
    <FeatureToggleCard
      title={title}
      enabled={enabled}
      busy={toggling}
      disabled={features == null}
      onToggle={() => { if (features) toggle(!enabled); }}
      toggleTitle={`${enabled ? 'Disable' : 'Enable'} ${what}`}
    >
      <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">{children}</div>
      {error && (
        <div className="mt-3 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded text-sm text-red-700 dark:text-red-300">{error}</div>
      )}
    </FeatureToggleCard>
  );
}

const B = ({ children }) => <span className="font-medium">{children}</span>;

// Matrix sharing reaches people outside the analyst team, so it is off until an
// operator switches it on. Off hides every sharing control and the Shared
// Matrices tab, and the API refuses the share endpoints — resolve included, so
// links that were already sent stop opening. Nothing is deleted.
function MatrixSharingCard({ features }) {
  return (
    <FlagCard features={features} name="matrixSharing" title="Matrix sharing" what="matrix sharing">
      Lets users with the <B>Create matrix share links</B> permission share a matrix with named colleagues from
      the wizard&apos;s <B>Share</B> step or the matrix bar&apos;s <B>Share…</B>, and manage those links under
      <B> Admin → Shared Matrices</B>. Turning this off hides all of that and stops existing share links from
      opening; the shares themselves are kept, so turning it back on restores them.
    </FlagCard>
  );
}

// Custom reports need an extra container (the local model server) before the
// "describe it" half works. Off hides the builder and stops saved reports being
// listed; nothing is deleted.
function CustomReportsCard({ features }) {
  return (
    <FlagCard features={features} name="customReports" title="Custom reports" what="custom reports">
      Lets analysts build their own reports on the <B>Reports</B> tab — by hand, or by describing them in plain
      language to a model running on this deployment (see <B>Admin → LLM</B> for its status). Turning this off
      hides the builder and stops saved reports from being listed or run; the saved reports themselves are kept.
    </FlagCard>
  );
}

// The context assistant builds context trees from search terms, typed or proposed
// by the local model. Off hides the "Describe it" option and the builder; trees
// already built are ordinary generated contexts and keep refreshing.
function ContextAssistantCard({ features }) {
  return (
    <FlagCard features={features} name="contextAssistant" title="Context assistant" what="the context assistant">
      Adds <B>Describe it</B> to <B>Contexts → New context tree</B>: analysts describe a process, application or
      project, pick search terms — typed, or proposed by the model running on this deployment — and choose the
      groups that belong to it. Turning this off hides the builder; contexts already built are kept and keep
      refreshing after each crawl.
    </FlagCard>
  );
}

// What a sync writes on its own: the owner a source names for a synced context
// becomes its Accountable. On by default; off leaves every Accountable alone.
function SourceOwnerSettings({ features }) {
  return (
    <section className="space-y-4" aria-labelledby="context-sync-settings">
      <h3 id="context-sync-settings" className="text-sm font-semibold text-gray-900 dark:text-white">
        Contexts — what a sync sets on its own
      </h3>
      <FlagCard features={features} name="sourceOwnerAccountables" title="Accountables from source owners" what="Accountables from source owners">
        When a source names the owner of a unit or application (by account key or employee number), that account
        becomes its <B>Accountable</B> on every sync, and follows the source when the owner changes. An Accountable
        an analyst chose is never overwritten. Turning this off leaves every Accountable as it is.
      </FlagCard>
    </section>
  );
}

export default function ExperimentalFeaturesSection({ features, version }) {
  const types = experimentalCrawlerTypes();
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4">
        <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">What &quot;experimental&quot; means</h3>
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

      <FlagCard features={features} name="experimentalCrawlers" title="Experimental crawlers" what="experimental crawlers">
        Offers the crawler types below in <B>Admin → Crawlers → Add Crawler</B>. Turning this off does not disable
        an experimental crawler you already configured — it keeps its schedule and keeps syncing — it only stops a
        new one being added.
        <CrawlerList types={types} />
      </FlagCard>

      <MatrixSharingCard features={features} />
      <CustomReportsCard features={features} />
      <ContextAssistantCard features={features} />
      <SourceOwnerSettings features={features} />
    </div>
  );
}
