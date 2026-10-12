// Whether the deployment's local model can extract right now
// (GET /api/org-truth/knowledge/status → { configured, reachable, model, state, activeRunId, setup }).
// Extraction never falls back to an external AI, so a missing model is a setup
// step for the operator, said as such. Renders nothing until the status is in.
const WARN = 'rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200';
const OK = 'text-xs text-gray-600 dark:text-gray-400';

export default function ModelStatusBanner({ status }) {
  if (!status) return null;
  if (!status.configured || !status.reachable) {
    return (
      <div role="status" className={WARN}>
        <p className="font-medium">
          {status.configured ? 'The local model is not reachable right now.' : 'No local model is configured for this deployment.'}
        </p>
        <p className="mt-1">
          {status.setup || 'Transcripts can be added; extraction starts once the deployment\'s own model is up. Nothing is sent to an external AI.'}
        </p>
      </div>
    );
  }
  return (
    <p className={OK}>
      Local model: <span className="font-medium">{status.model || 'ready'}</span>
      {status.activeRunId && ' · an extraction is running'}
    </p>
  );
}
