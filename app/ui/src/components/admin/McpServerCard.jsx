// Admin → Experimental → MCP server.
//
// The switch for the MCP endpoint that lets AI assistants (Claude, ChatGPT,
// Copilot) read data on behalf of the signed-in user, and — while it is on —
// what to give an assistant (the URL and scope) and what assistants have done
// recently (the audit log, GET /api/admin/mcp). The server refuses to switch it
// on while sign-in is off; that refusal is shown under the switch.
import { useEffect, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import useFeatureToggle from '@ui/hooks/useFeatureToggle';
import { FeatureToggleCard } from './adminUi';

const RECENT = 20;

function useMcpStatus(enabled) {
  const { authFetch } = useAuth();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    authFetch(`/api/admin/mcp?limit=${RECENT}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => { if (!cancelled) setStatus(d); })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [enabled, authFetch]);
  return { status, error };
}

function Field({ label, value }) {
  return (
    <div className="mt-2 text-sm">
      <span className="text-gray-600 dark:text-gray-400">{label}: </span>
      <code className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100 break-all">{value}</code>
    </div>
  );
}

function RecentCalls({ calls }) {
  if (!calls.length) {
    return <p className="mt-3 text-sm text-gray-600 dark:text-gray-400 italic">No assistant has used it yet.</p>;
  }
  return (
    <table className="mt-3 w-full text-sm">
      <thead>
        <tr className="text-left text-gray-600 dark:text-gray-400">
          <th className="py-1 pr-3 font-medium">When</th>
          <th className="py-1 pr-3 font-medium">Who</th>
          <th className="py-1 pr-3 font-medium">Tool</th>
          <th className="py-1 pr-3 font-medium">Result</th>
          <th className="py-1 font-medium text-right">Rows</th>
        </tr>
      </thead>
      <tbody>
        {calls.map(c => (
          <tr key={c.id} className="border-t border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100">
            <td className="py-1 pr-3 whitespace-nowrap">{new Date(c.calledAt).toLocaleString()}</td>
            <td className="py-1 pr-3">{c.userName || '—'}</td>
            <td className="py-1 pr-3">{c.tool}</td>
            <td className="py-1 pr-3">{c.outcome}</td>
            <td className="py-1 text-right">{c.rowCount ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function McpServerCard({ features }) {
  const { toggle, toggling, error } = useFeatureToggle('mcpServer');
  const enabled = features?.mcpServer === true;
  const { status, error: statusError } = useMcpStatus(enabled);
  return (
    <FeatureToggleCard
      title="MCP server (AI assistants)"
      enabled={enabled}
      busy={toggling}
      disabled={features == null}
      onToggle={() => { if (features) toggle(!enabled); }}
      toggleTitle={enabled ? 'Disable the MCP server' : 'Enable the MCP server'}
    >
      <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
        Lets people connect an AI assistant — Claude, ChatGPT or Copilot — to Identity Atlas and ask it questions.
        The assistant signs in as that person and can only read what their role allows; it also needs the
        <span className="font-medium"> Use the MCP server</span> permission under
        <span className="font-medium"> Admin → Authentication &amp; roles</span>. Everything is read-only. What the
        assistant reads is sent to that assistant's vendor. Works only while sign-in is on.
      </p>
      {enabled && status && (
        <>
          <Field label="Server URL" value={status.url} />
          <Field label="Scope" value={status.scope} />
          <h4 className="mt-4 text-sm font-semibold text-gray-900 dark:text-white">Recent activity</h4>
          <RecentCalls calls={status.calls || []} />
        </>
      )}
      {enabled && statusError && (
        <p className="mt-3 text-sm text-red-700 dark:text-red-300">Could not load the activity log ({statusError}).</p>
      )}
      {error && (
        <div className="mt-3 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded text-sm text-red-700 dark:text-red-300">{error}</div>
      )}
    </FeatureToggleCard>
  );
}
