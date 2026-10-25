import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useDialog } from '@ui/components/dialogContext';
import { formatDateOnly } from '@ui/utils/formatters';
import AnswerInput from './AnswerInput';
import {
  textIn, fill, visibleQuestions, progress, setAnswer, answerAllRows, wordsFor, pageOf, forSaving, columnLabel,
} from './surveyText';

// Answering one survey (docs/architecture/survey-templates.md).
//
// GET /api/surveys/requests/:id gives the questions (the template version it was
// sent with), the rows of every per-row question, and the answers so far. What
// is filled in is saved as a draft a moment after each change (PUT …/answers);
// Submit (POST …/submit) turns the answers into claims for an analyst to review.
// The recipient answers for themselves; an analyst may fill it in on the
// recipient's behalf, and the form says so. An answered or withdrawn survey
// opens read-only.

export const ROWS_PER_PAGE = 25;
export const SAVE_DELAY_MS = 1200;

const SECTION = 'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800';

function RowQuestion({ q, rows, answers, onAnswer, ctx }) {
  const [page, setPage] = useState(0);
  const { words, lang, def, readOnly } = ctx;
  const columns = q.rows.columns?.length ? q.rows.columns : ['displayName'];
  const shownPage = pageOf(rows, page, ROWS_PER_PAGE);
  const asked = ctx.text(q.text);
  const bulk = q.answer.type === 'yesNo' ? { label: words.allYes, value: 'yes' } : (q.answer.type === 'confirm' ? { label: words.allCorrect, value: { ok: true } } : null);
  return (
    <div className="overflow-x-auto">
      {bulk && !readOnly && rows.length > 1 && (
        <button type="button" onClick={() => onAnswer(answerAllRows(answers, q.id, rows.map(r => r.id), bulk.value))}
          className="mb-2 rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">
          {bulk.label}
        </button>
      )}
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs text-gray-600 dark:bg-gray-700/50 dark:text-gray-300">
          <tr>
            {columns.map(c => <th key={c} className="px-2 py-1.5 font-medium">{columnLabel(c, lang)}</th>)}
            <th className="px-2 py-1.5 font-medium">{asked}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {shownPage.rows.map(r => (
            <tr key={r.id} className="align-top">
              {columns.map(c => <td key={c} className="px-2 py-1.5 text-gray-800 dark:text-gray-200">{r.columns?.[c] ?? ''}</td>)}
              <td className="px-2 py-1.5 min-w-[14rem]">
                <AnswerInput question={q} value={answers[q.id]?.[r.id]} lang={lang} def={def}
                  label={`${asked} (${r.displayName})`} shown={q.answer.shows ? r.columns?.[q.answer.shows] : null}
                  searchUrl={ctx.searchUrl} inputId={`${q.id}-${r.id}`}
                  onChange={v => onAnswer(setAnswer(answers, q.id, v, r.id))} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="py-2 text-sm text-gray-600 dark:text-gray-400">{words.nobody}</p>}
      {shownPage.pages > 1 && (
        <div className="mt-2 flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
          <button type="button" disabled={shownPage.page === 0} onClick={() => setPage(shownPage.page - 1)} className="rounded border border-gray-300 px-2 py-0.5 disabled:opacity-50 dark:border-gray-600">{words.previous}</button>
          <span>{shownPage.page + 1} / {shownPage.pages}</span>
          <button type="button" disabled={shownPage.page >= shownPage.pages - 1} onClick={() => setPage(shownPage.page + 1)} className="rounded border border-gray-300 px-2 py-0.5 disabled:opacity-50 dark:border-gray-600">{words.next}</button>
        </div>
      )}
    </div>
  );
}

function Question({ q, answers, onAnswer, ctx, rows }) {
  const asked = ctx.text(q.text);
  return (
    <div className="space-y-1.5" data-testid={`question-${q.id}`}>
      <div className="text-sm font-medium text-gray-900 dark:text-white">
        {asked}{q.required && <span className="ml-0.5 text-red-700 dark:text-red-300" aria-hidden="true">*</span>}
      </div>
      {q.help && <p className="text-xs text-gray-600 dark:text-gray-400">{ctx.text(q.help)}</p>}
      {q.rows
        ? <RowQuestion q={q} rows={rows[q.id] || []} answers={answers} onAnswer={onAnswer} ctx={ctx} />
        : (
          <AnswerInput question={q} value={answers[q.id]} lang={ctx.lang} def={ctx.def} label={asked}
            shown={q.answer.shows ? ctx.contextValues?.[q.answer.shows] : null} searchUrl={ctx.searchUrl} inputId={`q-${q.id}`}
            onChange={v => onAnswer(setAnswer(answers, q.id, v))} />
        )}
    </div>
  );
}

function sectionsWith(def, shown) {
  const byId = new Map();
  for (const q of shown) {
    if (!byId.has(q.sectionId)) byId.set(q.sectionId, []);
    byId.get(q.sectionId).push(q);
  }
  return (def.sections || []).filter(s => byId.has(s.id)).map(s => ({ ...s, shown: byId.get(s.id) }));
}

// Save a draft a moment after the last change; returns the save state.
function useDraftSaver(requestId, answers, enabled) {
  const { authFetch } = useAuth();
  const [state, setState] = useState('idle');
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return undefined; }
    if (!enabled) return undefined;
    const t = setTimeout(async () => {
      setState('saving');
      const r = await authFetch(`/api/surveys/requests/${requestId}/answers`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: forSaving(answers) }),
      }).catch(() => null);
      setState(r?.ok ? 'saved' : 'failed');
    }, SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [answers, enabled, requestId, authFetch]);
  return state;
}

// `preview`: the template editor's view — answerable, but nothing is saved or sent.
function SurveyBody({ data, onDone, preview = false }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const def = data.definition;
  const [lang, setLang] = useState(data.language && def.languages.includes(data.language) ? data.language : def.languages[0]);
  const [answers, setAnswers] = useState(data.answers || {});
  const [errors, setErrors] = useState(null);
  const [busy, setBusy] = useState(false);
  const readOnly = !preview && data.status !== 'sent';
  const saveState = useDraftSaver(data.id, answers, !readOnly && !preview);
  const words = wordsFor(lang);
  const fills = { context: data.contextName, respondent: data.recipientName };
  const ctx = {
    lang, def, words, readOnly, contextValues: data.contextValues,
    text: (t) => fill(textIn(t, lang, def), fills),
    // A preview has no request yet: the analyst searches as anywhere else.
    searchUrl: preview
      ? (term) => `/api/users?search=${encodeURIComponent(term)}&limit=10`
      : (term) => `/api/surveys/requests/${data.id}/people?search=${encodeURIComponent(term)}`,
  };
  const shown = useMemo(() => visibleQuestions(def, answers), [def, answers]);
  const done = progress(def, answers, data.rows);

  async function submit() {
    setBusy(true); setErrors(null);
    try {
      const r = await authFetch(`/api/surveys/requests/${data.id}/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: forSaving(answers), language: lang }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { setErrors(body.details?.errors?.length ? body.details.errors : [{ message: body.error || `HTTP ${r.status}` }]); return; }
      dialog.toast(lang === 'nl' ? 'Bedankt — uw antwoorden zijn verstuurd.' : 'Thank you — your answers were sent.', { variant: 'success' });
      onDone?.();
    } finally {
      setBusy(false);
    }
  }

  const questionText = (id) => ctx.text(shown.find(q => q.id === id)?.text ?? id);
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <SurveyHeader data={data} ctx={ctx} setLang={setLang} done={done} onBehalf={!data.asRecipient && !readOnly && !preview} />
      <fieldset disabled={readOnly || busy} className="space-y-4">
        {sectionsWith(def, shown).map(s => (
          <section key={s.id} className={SECTION} aria-label={s.title ? ctx.text(s.title) : s.id}>
            {s.title && <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-300">{ctx.text(s.title)}</h3>}
            <div className="space-y-4">
              {s.shown.map(q => <Question key={q.id} q={q} answers={answers} onAnswer={setAnswers} ctx={ctx} rows={data.rows || {}} />)}
            </div>
          </section>
        ))}
      </fieldset>
      {errors && <ErrorList errors={errors} questionText={questionText} />}
      {!readOnly && !preview && <SubmitBar saveState={saveState} words={words} onSubmit={submit} busy={busy} />}
    </div>
  );
}

function ErrorList({ errors, questionText }) {
  return (
    <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-200">
      <ul className="list-disc pl-5">
        {errors.map((e, i) => <li key={i}>{e.question ? `${questionText(e.question)}: ` : ''}{e.message}</li>)}
      </ul>
    </div>
  );
}

const SAVE_LABEL = { saving: () => '…', saved: (w) => w.saved, failed: () => 'Not saved' };

function SubmitBar({ saveState, words, onSubmit, busy }) {
  return (
    <div className="flex items-center justify-end gap-3">
      <span className="text-xs text-gray-600 dark:text-gray-400" aria-live="polite">{SAVE_LABEL[saveState]?.(words) ?? ''}</span>
      <button type="button" onClick={onSubmit} disabled={busy}
        className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600">
        {words.submit}
      </button>
    </div>
  );
}

// What an answered or withdrawn survey says instead of the submit button.
function closedNote(data) {
  if (data.status !== 'submitted') return 'This survey was withdrawn.';
  return `Answered${data.submittedAt ? ` on ${formatDateOnly(data.submittedAt)}` : ''}.`;
}

function LanguageSwitch({ languages, lang, setLang }) {
  if (languages.length < 2) return null;
  return (
    <div role="group" aria-label="Language" className="flex gap-1">
      {languages.map(l => (
        <button key={l} type="button" aria-pressed={l === lang} onClick={() => setLang(l)}
          className={`rounded px-2 py-0.5 text-xs font-medium uppercase ${l === lang ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'}`}>{l}</button>
      ))}
    </div>
  );
}

function SurveyHeader({ data, ctx, setLang, done, onBehalf }) {
  const { def, words, lang, readOnly } = ctx;
  return (
    <div className={SECTION}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{ctx.text(def.title)}</h2>
        <LanguageSwitch languages={def.languages} lang={lang} setLang={setLang} />
      </div>
      {def.intro && <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{ctx.text(def.intro)}</p>}
      {data.message && <p className="mt-2 rounded bg-gray-50 p-2 text-sm italic text-gray-700 dark:bg-gray-700/50 dark:text-gray-300">{data.message}</p>}
      <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
        {data.dueAt && <>{words.due} {formatDateOnly(data.dueAt)} · </>}
        {done.answered} {words.of} {done.total} {words.answered}
      </p>
      {onBehalf && (
        <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-200" data-testid="on-behalf">
          You are filling this in on behalf of {data.recipientName}. It is recorded as entered by you.
        </p>
      )}
      {readOnly && (
        <p className="mt-2 rounded bg-gray-100 p-2 text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-200" data-testid="survey-closed">{closedNote(data)}</p>
      )}
    </div>
  );
}

/** A template's questions as the respondent will see them, with nothing saved. */
export function SurveyPreview({ definition, contextName = 'Example', rows = {} }) {
  const data = {
    id: 'preview', definition, rows, answers: {}, status: 'sent', asRecipient: true,
    contextName, recipientName: 'the respondent', contextValues: {},
  };
  return <SurveyBody key={JSON.stringify(definition)} data={data} preview />;
}

const OPEN_ERRORS = {
  'HTTP 403': 'This survey was sent to someone else.',
  'HTTP 404': 'This survey does not exist (any more).',
};

export default function SurveyForm({ requestId, onDone }) {
  const { authFetch } = useAuth();
  const { data, loading, error } = useFetch(`/api/surveys/requests/${requestId}`, { authFetch });
  if (loading) return <p className="p-6 text-sm text-gray-600 dark:text-gray-400">Loading the survey…</p>;
  if (error) return <p role="alert" className="p-6 text-sm text-red-700 dark:text-red-300">{OPEN_ERRORS[error.message] ?? error.message}</p>;
  if (!data) return null;
  return <SurveyBody key={data.id} data={data} onDone={onDone} />;
}
