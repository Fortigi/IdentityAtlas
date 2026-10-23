import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { PersonSearch } from '@ui/components/contexts/ContextRoleModal';
import { Modal, Field, ErrorBox, PrimaryButton, SecondaryButton } from '@ui/components/contexts/ModalPrimitives';
import { sendBody } from './send.helpers';

// ─── Send a survey about this context ─────────────────────────────────────
// A template that applies here (GET /api/surveys/templates?contextId=), who
// receives it — the context's Accountable or a person picked — and optionally
// every unit below of the same kind, each to its own Accountable. POST
// /api/contexts/:id/surveys answers { sent, skipped }.

const INPUT = 'w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';

export default function SendSurveyModal({ contextId, onSent, onClose }) {
  const { authFetch } = useAuth();
  const { data: templates, loading } = useFetch(`/api/surveys/templates?contextId=${contextId}`, {
    authFetch, initialData: [], transform: b => b.data || [],
  });
  const [templateId, setTemplateId] = useState('');
  const [to, setTo] = useState('accountable');
  const [person, setPerson] = useState(null);
  const [includeSubContexts, setIncludeSubContexts] = useState(false);
  const [dueAt, setDueAt] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const chosen = templateId || templates[0]?.id || '';

  async function send() {
    setBusy(true); setError(null);
    try {
      const r = await authFetch(`/api/contexts/${contextId}/surveys`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sendBody({ templateId: chosen, to, person, includeSubContexts, dueAt, message })),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      onSent(body);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const ready = chosen && (to === 'accountable' || person);
  return (
    <Modal title="Send survey" subtitle="Answers come back as claims to review under What we know." onClose={onClose} width={520} dismissOnBackdrop={false}>
      <div className="space-y-3 text-xs">
        {!loading && templates.length === 0 && (
          <p className="text-gray-700 dark:text-gray-300">No survey template applies here yet. Add one under Surveys → Templates.</p>
        )}
        {templates.length > 0 && (
          <Field label="Survey">
            <select aria-label="Survey" value={chosen} onChange={e => setTemplateId(e.target.value)} className={INPUT}>
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
        )}
        <fieldset className="space-y-1">
          <legend className="font-medium text-gray-700 dark:text-gray-300">Send to</legend>
          <label className="flex items-center gap-2 text-gray-800 dark:text-gray-200">
            <input type="radio" name="survey-to" checked={to === 'accountable'} onChange={() => setTo('accountable')} /> Its Accountable
          </label>
          <label className="flex items-center gap-2 text-gray-800 dark:text-gray-200">
            <input type="radio" name="survey-to" checked={to === 'person'} onChange={() => setTo('person')} /> Someone else
          </label>
        </fieldset>
        {to === 'person' && (person
          ? (
            <p className="text-gray-700 dark:text-gray-300">
              To: <span className="font-medium text-gray-900 dark:text-white">{person.displayName}</span>{' '}
              <button type="button" onClick={() => setPerson(null)} className="text-blue-700 underline dark:text-blue-300">change</button>
            </p>
          )
          : <PersonSearch inputId="survey-recipient" label="Who receives it" onPick={setPerson} />)}
        <label className="flex items-start gap-2 text-gray-800 dark:text-gray-200">
          <input type="checkbox" checked={includeSubContexts} onChange={e => setIncludeSubContexts(e.target.checked)} className="mt-0.5" />
          <span>Also send it about every unit below this one, each to its own Accountable</span>
        </label>
        <Field label="Answer before (optional)">
          <input type="date" aria-label="Answer before" value={dueAt} onChange={e => setDueAt(e.target.value)} className={`${INPUT} max-w-[12rem]`} />
        </Field>
        <Field label="Message (optional)">
          <textarea aria-label="Message" rows={2} value={message} onChange={e => setMessage(e.target.value)} className={INPUT} />
        </Field>
      </div>
      <ErrorBox message={error} />
      <div className="mt-3 flex justify-end gap-2">
        <SecondaryButton onClick={onClose} disabled={busy}>Cancel</SecondaryButton>
        <PrimaryButton onClick={send} disabled={busy || !ready}>{busy ? 'Sending…' : 'Send'}</PrimaryButton>
      </div>
    </Modal>
  );
}
