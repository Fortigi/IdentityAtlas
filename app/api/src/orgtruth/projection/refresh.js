// Organisation truth — rebuild both projection trees.
//
// Called at the end of an import run and after a source is deleted, so the
// contexts follow the claims: a project that is gone from the org tables is
// gone from Contexts after the next refresh. The two plugins run one after the
// other (awaitCompletion), never concurrently with each other; a failure of one
// is logged and does not stop the other.
import { enqueueRun } from '../../contexts/plugins/runner.js';

export const PROJECTION_PLUGINS = ['org-truth', 'org-truth-principals'];

export async function refreshProjections(triggeredBy, log = (msg) => console.log(`[org-truth] ${msg}`)) {
  for (const plugin of PROJECTION_PLUGINS) {
    try {
      await enqueueRun(plugin, { instanceKey: plugin }, triggeredBy, { awaitCompletion: true });
    } catch (err) {
      log(`projection ${plugin} not run: ${err.message}`);
    }
  }
}
