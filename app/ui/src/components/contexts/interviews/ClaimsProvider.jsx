import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useHasPermission } from '@ui/auth/usePermissions';
import { useIsSharedView } from '@ui/contexts/SharedViewContext';
import { useDialog } from '@ui/components/dialogContext';
import { ClaimsContext } from './claimsContext';
import { anyInProgress, subjectLabel } from './claims.helpers';

// ─── The claims of one context, for everything on its page ───────────────
// Reads GET /api/contexts/:id/claims (a reader without data.write.contexts is
// answered with confirmed claims only — the API decides, not this component)
// and, for a writer, GET …/interviews, refreshed every few seconds while one is
// still being read. decide(claim, body) PATCHes a claim; when an Accountable is
// already set the API answers 409 with the current holder, and the analyst is
// asked whether to replace them. `rolesVersion` goes up after every decision
// that may have changed a role, so the People block re-reads its roles.

export const POLL_MS = 4000;

async function readError(r) {
  const body = await r.json().catch(() => ({}));
  return { status: r.status, error: body.error || `HTTP ${r.status}`, details: body.details };
}

export default function ClaimsProvider({ contextId, children }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const sharedView = useIsSharedView();
  const canWrite = useHasPermission('data.write.contexts') && !sharedView;
  const claims = useFetch(`/api/contexts/${contextId}/claims`, { authFetch, initialData: { data: [], accountableDoubt: null } });
  const interviews = useFetch(`/api/contexts/${contextId}/interviews`, { authFetch, enabled: canWrite, initialData: [], transform: b => b.data || [] });
  const [rolesVersion, bumpRoles] = useReducer(n => n + 1, 0);
  const reloadClaims = claims.reload;
  const reloadInterviews = interviews.reload;

  const reading = canWrite && anyInProgress(interviews.data);
  useEffect(() => {
    if (!reading) return undefined;
    const timer = setInterval(() => { reloadInterviews(); reloadClaims(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [reading, reloadInterviews, reloadClaims]);

  const patch = useCallback(async (claim, body) => {
    const r = await authFetch(`/api/contexts/claims/${claim.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return r.ok ? { ok: true, result: await r.json() } : { ok: false, ...(await readError(r)) };
  }, [authFetch]);

  // Resolves to { ok } or { ok: false, error }; a declined replacement is { ok: false, cancelled: true }.
  const decide = useCallback(async (claim, body) => {
    let out = await patch(claim, body);
    const current = out.status === 409 ? out.details?.current : null;
    if (current) {
      const replace = await dialog.confirm({
        title: 'Replace the Accountable?',
        message: `${current.displayName || 'Someone'} is the Accountable now. Replace them with ${subjectLabel(claim) || 'this person'}?`,
        confirmLabel: 'Replace',
      });
      if (!replace) return { ok: false, cancelled: true };
      out = await patch(claim, { ...body, replace: true });
    }
    if (out.ok) { reloadClaims(); reloadInterviews(); bumpRoles(); }
    return out;
  }, [patch, dialog, reloadClaims, reloadInterviews]);

  const value = useMemo(() => ({
    contextId,
    canWrite,
    claims: claims.data?.data || [],
    accountableDoubt: claims.data?.accountableDoubt || null,
    loading: claims.loading,
    error: claims.error,
    interviews: interviews.data || [],
    rolesVersion,
    decide,
    reload: () => { reloadClaims(); reloadInterviews(); },
  }), [contextId, canWrite, claims.data, claims.loading, claims.error, interviews.data, rolesVersion, decide, reloadClaims, reloadInterviews]);

  return <ClaimsContext.Provider value={value}>{children}</ClaimsContext.Provider>;
}
