import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';

// ─── Mentioned in interviews — on an account's or a person's page ────────
// The contexts whose interviews say something about this account or person
// (GET /api/contexts/claims/mentions; a reader without data.write.contexts is
// answered with confirmed claims only), each a link to the context, with how
// many claims and the latest interview. Nothing when there are none.
// `holder` is { principalId } or { identityId }.

export default function InterviewMentions({ holder, onOpenDetail }) {
  const { authFetch } = useAuth();
  const [col, id] = Object.entries(holder || {}).find(([, v]) => v) || [];
  const { data } = useFetch(col ? `/api/contexts/claims/mentions?${col}=${encodeURIComponent(id)}` : null,
    { authFetch, initialData: [], transform: b => b.data || [] });
  if (!data || data.length === 0) return null;
  return (
    <section aria-label="Mentioned in interviews" className="mt-4 rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Mentioned in interviews</h3>
      <ul className="mt-1 space-y-0.5 text-sm">
        {data.map(m => (
          <li key={m.contextId} className="text-gray-900 dark:text-gray-200">
            {onOpenDetail
              ? <button type="button" onClick={() => onOpenDetail('context', m.contextId, m.contextName)} className="font-medium text-blue-700 hover:underline dark:text-blue-300">{m.contextName}</button>
              : <span className="font-medium">{m.contextName}</span>}
            <span className="text-xs text-gray-600 dark:text-gray-400"> · {m.claims} claim{m.claims === 1 ? '' : 's'} · last interview {m.lastInterviewedAt}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
