import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useHasPermission } from '@ui/auth/usePermissions';
import { useIsSharedView } from '@ui/contexts/SharedViewContext';
import { useDialog } from '@ui/components/dialogContext';
import { ClaimsContext, useContextClaims } from './claimsContext';
import { anyInProgress, subjectLabel } from './claims.helpers';
import TranscriptPanel from './TranscriptPanel';

// ─── The claims of one context, for everything on its page ───────────────
// Reads GET /api/contexts/:id/claims (a reader without data.write.contexts is
// answered with confirmed claims only — the API decides, not this component)
// and, for a writer, GET …/interviews, refreshed every few seconds while one is
// still being read. decide(claim, body) PATCHes a claim; when an Accountable is
// already set the API answers 409 with the current holder, and the analyst is
// asked whether to replace them. `contradictions` are the API's pairs of a claim
// and what it disagrees with (Contradictions.jsx decides them through decide()). rejectMany({ kind?, relevance? }) rejects the
// proposed claims of a kind or a relevance tier in one request. `rolesVersion`
// goes up after every decision that may have changed a role, so the People
// block re-reads its roles; `onDecided` tells the page (its members lists show
// what the interviews say about people).
//
// openTranscript(interviewId, claimId?) opens the transcript view, scrolled to
// the claim's quote when one is given. Analysts only (null for a reader): the
// transcript itself is served only with data.write.contexts.
//
// The detail page provides it around the whole page (members lists included);
// ContextProfile provides it too, for where it is mounted alone. A provider
// inside another for the same context adds nothing: the outer one serves both.

export const POLL_MS = 4000;

async function readError(r) {
  const body = await r.json().catch(() => ({}));
  return { status: r.status, error: body.error || `HTTP ${r.status}`, details: body.details };
}

export default function ClaimsProvider({ contextId, children, onDecided }) {
  const outer = useContextClaims();
  if (outer && outer.contextId === contextId) return children;
  return <OwnClaimsProvider contextId={contextId} onDecided={onDecided}>{children}</OwnClaimsProvider>;
}

function OwnClaimsProvider({ contextId, children, onDecided }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const sharedView = useIsSharedView();
  const canWrite = useHasPermission('data.write.contexts') && !sharedView;
  const claims = useFetch(`/api/contexts/${contextId}/claims`, { authFetch, initialData: { data: [], accountableDoubt: null, contradictions: [] } });
  const interviews = useFetch(`/api/contexts/${contextId}/interviews`, { authFetch, enabled: canWrite, initialData: [], transform: b => b.data || [] });
  const [rolesVersion, bumpRoles] = useReducer(n => n + 1, 0);
  // The open transcript: { interviewId, claimId, at } — `at` makes a second click on the same claim scroll again.
  const [transcript, setTranscript] = useState(null);
  const reloadClaims = claims.reload;
  const reloadInterviews = interviews.reload;

  const reading = canWrite && anyInProgress(interviews.data);
  useEffect(() => {
    if (!reading) return undefined;
    const timer = setInterval(() => { reloadInterviews(); reloadClaims(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [reading, reloadInterviews, reloadClaims]);

  const changed = useCallback(() => { reloadClaims(); reloadInterviews(); bumpRoles(); onDecided?.(); }, [reloadClaims, reloadInterviews, onDecided]);

  const send = useCallback(async (url, method, body) => {
    const r = await authFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.ok ? { ok: true, result: await r.json() } : { ok: false, ...(await readError(r)) };
  }, [authFetch]);

  // Resolves to { ok } or { ok: false, error }; a declined replacement is { ok: false, cancelled: true }.
  const decide = useCallback(async (claim, body) => {
    const url = `/api/contexts/claims/${claim.id}`;
    let out = await send(url, 'PATCH', body);
    const current = out.status === 409 ? out.details?.current : null;
    if (current) {
      const replace = await dialog.confirm({
        title: 'Replace the Accountable?',
        message: `${current.displayName || 'Someone'} is the Accountable now. Replace them with ${subjectLabel(claim) || 'this person'}?`,
        confirmLabel: 'Replace',
      });
      if (!replace) return { ok: false, cancelled: true };
      out = await send(url, 'PATCH', { ...body, replace: true });
    }
    if (out.ok) changed();
    return out;
  }, [send, dialog, changed]);

  const rejectMany = useCallback(async (filter) => {
    const out = await send(`/api/contexts/${contextId}/claims/reject`, 'POST', filter);
    if (out.ok) changed();
    return out;
  }, [send, contextId, changed]);

  const openTranscript = useCallback((interviewId, claimId = null) => {
    if (interviewId) setTranscript({ interviewId, claimId, at: Date.now() });
  }, []);

  const value = useMemo(() => ({
    contextId,
    canWrite,
    claims: claims.data?.data || [],
    accountableDoubt: claims.data?.accountableDoubt || null,
    contradictions: claims.data?.contradictions || [],
    loading: claims.loading,
    error: claims.error,
    interviews: interviews.data || [],
    rolesVersion,
    decide,
    rejectMany,
    openTranscript: canWrite ? openTranscript : null,
    reload: () => { reloadClaims(); reloadInterviews(); },
  }), [contextId, canWrite, claims.data, claims.loading, claims.error, interviews.data, rolesVersion, decide, rejectMany, openTranscript, reloadClaims, reloadInterviews]);

  return (
    <ClaimsContext.Provider value={value}>
      {children}
      {canWrite && transcript && (
        <TranscriptPanel key={transcript.interviewId} interviewId={transcript.interviewId} focus={transcript} onClose={() => setTranscript(null)} />
      )}
    </ClaimsContext.Provider>
  );
}
