import { useRef, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { Modal, Field, ErrorBox, PrimaryButton, SecondaryButton } from '@ui/components/contexts/ModalPrimitives';
import { KIND_LABELS, RELATION_LABELS, PERSON_KINDS, manualClaimBody, manualClaimReady } from './claims.helpers';

// ─── Add a claim by hand ─────────────────────────────────────────────────
// The way to record what an interview says without a model (and next to one).
// The transcript is shown read-only; select the words a claim rests on and
// "Use the selection as quote" copies them (the API checks the quote is a
// verbatim part of the transcript). POST /api/contexts/:id/interviews/:iv/claims;
// the claim is proposed, and then reviewed like any other.

const INPUT = 'mt-1 w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';
const EMPTY = { kind: 'description', value: '', subject: '', relation: 'owner', attribute: '', periodText: '', quote: '' };

export default function ManualClaimForm({ contextId, interview, onAdded, onClose }) {
  const { authFetch } = useAuth();
  const { data } = useFetch(`/api/contexts/${contextId}/interviews/${interview.id}`, { authFetch });
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const transcriptRef = useRef(null);
  const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }));

  function takeSelection() {
    const el = transcriptRef.current;
    if (!el) return;
    const picked = el.value.slice(el.selectionStart, el.selectionEnd).trim();
    if (picked) setForm(f => ({ ...f, quote: picked }));
  }

  async function submit() {
    setBusy(true); setError(null);
    try {
      const r = await authFetch(`/api/contexts/${contextId}/interviews/${interview.id}/claims`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(manualClaimBody(form)),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      onAdded();
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add a claim" subtitle={`From the interview with ${interview.intervieweeName}, ${interview.interviewedAt}`} onClose={onClose} width={620} dismissOnBackdrop={false}>
      <div className="space-y-2">
        <label htmlFor="manual-claim-transcript" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Transcript</label>
        <textarea id="manual-claim-transcript" ref={transcriptRef} readOnly rows={8} value={data?.transcript ?? 'Loading…'}
          className="w-full rounded border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-900/40 dark:text-gray-200" />
        <SecondaryButton onClick={takeSelection}>Use the selection as quote</SecondaryButton>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Kind">
            <select aria-label="Kind" className={INPUT} value={form.kind} onChange={set('kind')}>
              {Object.entries(KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          {PERSON_KINDS.has(form.kind) && (
            <Field label="Person"><input aria-label="Person" className={INPUT} value={form.subject} onChange={set('subject')} /></Field>
          )}
          {form.kind === 'property' && (
            <Field label="Attribute"><input aria-label="Attribute" className={INPUT} value={form.attribute} onChange={set('attribute')} /></Field>
          )}
        </div>
        {form.kind === 'role' && (
          <Field label="What they are to it">
            <select aria-label="What they are to it" className={INPUT} value={form.relation} onChange={set('relation')}>
              {Object.entries(RELATION_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
        )}
        <Field label="What it says"><input aria-label="What it says" className={INPUT} value={form.value} onChange={set('value')} /></Field>
        <Field label="Period, as said"><input aria-label="Period, as said" className={INPUT} value={form.periodText} onChange={set('periodText')} /></Field>
        <Field label="Quote"><textarea aria-label="Quote" rows={2} className={INPUT} value={form.quote} onChange={set('quote')} /></Field>
      </div>
      <ErrorBox message={error} />
      <div className="mt-3 flex justify-end gap-2">
        <SecondaryButton onClick={onClose} disabled={busy}>Cancel</SecondaryButton>
        <PrimaryButton onClick={submit} disabled={busy || !manualClaimReady(form)}>Add claim</PrimaryButton>
      </div>
    </Modal>
  );
}
