// Organisation truth — rebuild both projection trees.
//
// Called at the end of an import run and after a source is deleted, so the
// contexts follow the claims: a project that is gone from the org tables is
// gone from Contexts after the next refresh. The two plugins run one after the
// other (awaitCompletion), never concurrently with each other; a failure of one
// is logged and does not stop the other.
//
// After them, the context-assistant trees whose membership reads org truth (a
// "users with access to …" recipe counts the users linked to matching org
// entities) are refreshed too, the same way a crawl refreshes them.
import { enqueueRun, refreshGeneratedContexts } from '../../contexts/plugins/runner.js';

export const PROJECTION_PLUGINS = ['org-truth', 'org-truth-principals'];
// Plugins whose trees depend on org entities and their links (contexts/plugins/context-recipe-principals.js).
export const ORG_READING_PLUGINS = ['context-recipe-principals'];

export async function refreshProjections(triggeredBy, log = (msg) => console.log(`[org-truth] ${msg}`)) {
  for (const plugin of PROJECTION_PLUGINS) {
    try {
      await enqueueRun(plugin, { instanceKey: plugin }, triggeredBy, { awaitCompletion: true });
    } catch (err) {
      log(`projection ${plugin} not run: ${err.message}`);
    }
  }
  try {
    await refreshGeneratedContexts(triggeredBy, { awaitCompletion: true, algorithms: ORG_READING_PLUGINS });
  } catch (err) {
    log(`context recipes not refreshed: ${err.message}`);
  }
}
