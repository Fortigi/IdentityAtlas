// Admin → Experimental.
//
// One tab for everything that is built and tested but has not yet had much
// exposure to real-world data. Flags today (each card below says what it does):
// experimental crawlers, matrix sharing, custom reports, the context assistant,
// Org Info and knowledge extraction. The first three in more detail:
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

// One switch card for one flag: reads `features[flag]`, posts the flipped value,
// and shows a failed toggle under the copy. `noun` completes "Enable …/Disable …".
function FlagCard({ features, flag, title, noun, children }) {
  const { toggle, toggling, error } = useFeatureToggle(flag);
  const enabled = features?.[flag] === true;
  return (
    <FeatureToggleCard
      title={title}
      enabled={enabled}
      busy={toggling}
      disabled={features == null}
      onToggle={() => { if (features) toggle(!enabled); }}
      toggleTitle={`${enabled ? 'Disable' : 'Enable'} ${noun}`}
    >
      <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{children}</p>
      {error && (
        <div className="mt-3 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded text-sm text-red-700 dark:text-red-300">{error}</div>
      )}
    </FeatureToggleCard>
  );
}

// Matrix sharing reaches people outside the analyst team, so it is off until an
// operator switches it on. Off hides every sharing control and the Shared
// Matrices tab, and the API refuses the share endpoints — resolve included, so
// links that were already sent stop opening. Nothing is deleted: switching it
// back on restores the shares and their usage history.
function MatrixSharingCard({ features }) {
  return (
    <FlagCard features={features} flag="matrixSharing" title="Matrix sharing" noun="matrix sharing">
      Lets users with the <span className="font-medium">Create matrix share links</span> permission share a
      matrix with named colleagues from the wizard's <span className="font-medium">Share</span> step or the
      matrix bar's <span className="font-medium">Share…</span>, and manage those links under
      <span className="font-medium"> Admin → Shared Matrices</span>. Turning this off hides all of that and
      stops existing share links from opening; the shares themselves are kept, so turning it back on restores them.
    </FlagCard>
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
  return (
    <FlagCard features={features} flag="customReports" title="Custom reports" noun="custom reports">
      Lets analysts build their own reports on the <span className="font-medium">Reports</span> tab — by hand, or
      by describing them in plain language to a model running on this deployment (see
      <span className="font-medium"> Admin → LLM</span> for its status). Turning this off hides the builder and
      stops saved reports from being listed or run; the saved reports themselves are kept.
    </FlagCard>
  );
}

// The context assistant builds context trees from search terms. The terms can be typed,
// or proposed by the same local model custom reports use. Off hides the fourth option in
// the new-context wizard and the builder; trees already built are ordinary generated
// contexts and keep refreshing after each crawl.
function ContextAssistantCard({ features }) {
  return (
    <FlagCard features={features} flag="contextAssistant" title="Context assistant" noun="the context assistant">
      Adds <span className="font-medium">Describe it</span> to <span className="font-medium">Contexts → New context tree</span>:
      analysts describe a process, application or project, pick search terms — typed, or proposed by the model running on
      this deployment — and choose the groups that belong to it. Turning this off hides the builder; contexts already
      built are kept and keep refreshing after each crawl.
    </FlagCard>
  );
}

// Org Info (flag `orgTruth`): the organisation's own lists — customers, projects,
// staff lists, timesheets — imported next to the crawled data. Off hides the
// Organisation tab, the matrix's Organisation condition and the organisation edges
// in the relationship graph, and the API answers 404 on /api/org-truth; nothing
// imported is deleted, so switching it back on restores everything.
function OrgInfoCard({ features }) {
  return (
    <FlagCard features={features} flag="orgTruth" title="Org Info" noun="Org Info">
      Adds the <span className="font-medium">Organisation</span> tab, where the organisation's own lists — customers,
      projects, staff lists, timesheets — are imported with <span className="font-medium">Import additional information</span>,
      linked to the accounts, people and resources the crawlers found, and used in the matrix, the relationship graph and
      the signals. Turning this off hides all of that; the imported lists and their links are kept, so turning it back on
      restores them.
    </FlagCard>
  );
}

// Knowledge extraction (flag `knowledgeExtraction`): interview transcripts read by the
// deployment's own local model, which proposes mentions, statements and findings.
// Needs Org Info on; off hides the Knowledge tab and the API answers 404 on
// /api/org-truth/knowledge; transcripts and decisions are kept.
function KnowledgeExtractionCard({ features }) {
  return (
    <FlagCard features={features} flag="knowledgeExtraction" title="Knowledge extraction" noun="knowledge extraction">
      Adds a <span className="font-medium">Knowledge</span> tab to <span className="font-medium">Organisation</span>: upload an
      interview transcript and the model running on this deployment proposes who and what it mentions, and the statements it
      makes, each with the exact quote. Needs Org Info on and a local model (see <span className="font-medium">Admin → LLM</span>).
      Transcripts are read only by this deployment's own model, never sent to an external AI, and everything it proposes waits
      for review. Turning this off hides the tab; transcripts and review decisions are kept.
    </FlagCard>
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
      <ContextAssistantCard features={features} />
      <OrgInfoCard features={features} />
      <KnowledgeExtractionCard features={features} />
    </div>
  );
}
