import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { PersonSearch } from '@ui/components/contexts/ContextRoleModal';
import { Modal, Field, ErrorBox, PrimaryButton, SecondaryButton } from '@ui/components/contexts/ModalPrimitives';
import { surveyHash } from '@ui/components/surveys/surveyRoute';
import { startBody, respondentOf, emailOf } from './send.helpers';

// ─── Do survey: answer it here, nothing is sent ───────────────────────────
// GET /api/contexts/:id/surveys/start says which templates apply and who may
// answer: an analyst picks any account (their own by default when signed in;
// with auth off there is none, so one must be picked); someone holding a role
// here answers for themselves. POST …/start makes the request and the survey
// form opens on it (#surveys?request=<id>).
// docs/architecture/survey-templates.md → "Doing a survey in place".

const INPUT = 'w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';
const openByLink = (id) => { window.location.hash = surveyHash(id); };

function TemplatePicker({ templates, chosen, onChange }) {
  if (templates.length === 0) {
    return <p className="text-gray-700 dark:text-gray-300">No survey template applies here yet. Add one under Surveys → Templates.</p>;
  }
  return (
    <Field label="Survey">
      <select aria-label="Survey" value={chosen} onChange={e => onChange(e.target.value)} className={INPUT}>
        {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    </Field>
  );
}

function Respondent({ who, onChange }) {
  const email = emailOf(who);
  return (
    <p className="text-gray-700 dark:text-gray-300">
      <span className="font-medium text-gray-900 dark:text-white">{who.displayName || who.id}</span>
      {email && <span className="ml-1 text-gray-600 dark:text-gray-400">{email}</span>}
      {onChange && <> <button type="button" onClick={onChange} className="text-blue-700 underline dark:text-blue-300">change</button></>}
    </p>
  );
}

// "Who is answering?": the respondent (with a change link when another may be
// picked), or the account search when there is nobody yet.
function WhoAnswers({ options, who, onSearch, onPick }) {
  return (
    <div>
      <p className="font-medium text-gray-700 dark:text-gray-300">Who is answering?</p>
      {who
        ? <Respondent who={who} onChange={options.pickRespondent ? onSearch : null} />
        : <PersonSearch inputId="survey-respondent" label="The account answering" onPick={onPick} autoFocus={false} />}
      {options.pickRespondent && !options.respondent && (
        <p className="mt-0.5 text-gray-600 dark:text-gray-400">Nobody is signed in, so pick the account whose answers these are. They are recorded as answered on that person&apos;s behalf.</p>
      )}
    </div>
  );
}

export default function DoSurveyModal({ contextId, onClose, openSurvey = openByLink }) {
  const { authFetch } = useAuth();
  const { data: options } = useFetch(`/api/contexts/${contextId}/surveys/start`, { authFetch, initialData: null });
  const [templateId, setTemplateId] = useState('');
  const [person, setPerson] = useState(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const templates = options?.templates || [];
  const chosen = templateId || templates[0]?.id || '';
  const who = searching ? null : respondentOf(person, options);

  async function start() {
    setBusy(true); setError(null);
    try {
      const r = await authFetch(`/api/contexts/${contextId}/surveys/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(startBody({ templateId: chosen, person })),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      onClose();
      openSurvey(body.id);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  const pick = (p) => { setPerson(p); setSearching(false); };
  return (
    <Modal title="Do survey" subtitle="Answer it here and now. Nothing is sent; the answers become claims to review." onClose={onClose} width={520} dismissOnBackdrop={false}>
      {options && (
        <div className="space-y-3 text-xs">
          <TemplatePicker templates={templates} chosen={chosen} onChange={setTemplateId} />
          <WhoAnswers options={options} who={who} onSearch={() => setSearching(true)} onPick={pick} />
        </div>
      )}
      <ErrorBox message={error} />
      <div className="mt-3 flex justify-end gap-2">
        <SecondaryButton onClick={onClose} disabled={busy}>Cancel</SecondaryButton>
        <PrimaryButton onClick={start} disabled={busy || !chosen || !who}>{busy ? 'Starting…' : 'Start'}</PrimaryButton>
      </div>
    </Modal>
  );
}
