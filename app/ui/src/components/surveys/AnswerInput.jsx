import { PersonSearch } from '@ui/components/contexts/ContextRoleModal';
import { textIn, wordsFor } from './surveyText';

// One answer of a survey question, by answer type (docs/architecture/survey-templates.md):
// yesNo and confirm as two buttons, choice as buttons, multiChoice as
// checkboxes, text / date as inputs, person / people with the survey's own
// people search (a respondent may have no /api/users). `value` and `onChange`
// carry the answer in the API's shape (contexts/surveys/answers.js); `label` is
// the accessible name of the control (the question, plus the row when per row).

const PILL = 'rounded border px-2.5 py-1 text-xs font-medium';
const PILL_OFF = 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700';
const PILL_ON = 'border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-600';
const INPUT = 'w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500';

function Pills({ label, options, value, onChange }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
          onClick={() => onChange(value === o.value ? null : o.value)}
          className={`${PILL} ${value === o.value ? PILL_ON : PILL_OFF}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Checks({ label, options, value, onChange }) {
  const chosen = new Set(value || []);
  const toggle = (v) => {
    const next = new Set(chosen);
    if (next.has(v)) next.delete(v); else next.add(v);
    onChange(options.map(o => o.value).filter(x => next.has(x)));
  };
  return (
    <fieldset aria-label={label} className="space-y-1">
      {options.map(o => (
        <label key={o.value} className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
          <input type="checkbox" checked={chosen.has(o.value)} onChange={() => toggle(o.value)} />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

function Confirm({ label, value, onChange, shown, words }) {
  const state = value == null ? null : (value.ok ? 'ok' : 'no');
  return (
    <div className="space-y-1.5">
      {shown != null && shown !== '' && <div className="text-sm text-gray-800 dark:text-gray-200">{shown}</div>}
      <Pills label={label} value={state} onChange={(v) => onChange(v == null ? null : (v === 'ok' ? { ok: true } : { ok: false, value: '' }))}
        options={[{ value: 'ok', label: words.correct }, { value: 'no', label: words.notCorrect }]} />
      {state === 'no' && (
        <input aria-label={`${label}: ${words.rightValue}`} placeholder={words.rightValue} value={value.value || ''}
          onChange={e => onChange({ ok: false, value: e.target.value })} className={INPUT} />
      )}
    </div>
  );
}

const asPerson = (p) => ({ principalId: p.id, displayName: p.displayName });

function People({ label, value, onChange, many, searchUrl, inputId, words }) {
  const people = many ? (value || []) : (value ? [value] : []);
  const add = (p) => {
    const person = asPerson(p);
    if (!many) return onChange(person);
    if (people.some(x => x.principalId === person.principalId)) return undefined;
    return onChange([...people, person]);
  };
  const remove = (id) => onChange(many ? people.filter(x => (x.principalId ?? x.identityId) !== id) : null);
  return (
    <div className="space-y-1.5">
      {people.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {people.map(p => {
            const id = p.principalId ?? p.identityId;
            return (
              <li key={id} className="flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-800 dark:bg-blue-900/30 dark:text-blue-200">
                {p.displayName || id}
                <button type="button" aria-label={`${words.remove} ${p.displayName || id}`} onClick={() => remove(id)}
                  className="text-blue-800 hover:text-blue-900 dark:text-blue-200">✕</button>
              </li>
            );
          })}
        </ul>
      )}
      {(many || people.length === 0) && (
        <PersonSearch inputId={inputId} label={many && people.length ? words.addPerson : label} onPick={add} searchUrl={searchUrl} autoFocus={false} />
      )}
    </div>
  );
}

export default function AnswerInput({ question, value, onChange, lang, def, label, shown, searchUrl, inputId }) {
  const words = wordsFor(lang);
  const a = question.answer || {};
  const options = (a.options || []).map(o => ({ value: o.value, label: textIn(o.label ?? o.value, lang, def) }));
  switch (a.type) {
    case 'yesNo':
      return <Pills label={label} value={value} onChange={onChange} options={[{ value: 'yes', label: words.yes }, { value: 'no', label: words.no }]} />;
    case 'choice':
      return <Pills label={label} value={value} onChange={onChange} options={options} />;
    case 'multiChoice':
      return <Checks label={label} value={value} onChange={onChange} options={options} />;
    case 'confirm':
      return <Confirm label={label} value={value} onChange={onChange} shown={shown} words={words} />;
    case 'person':
    case 'people':
      return <People label={label} value={value} onChange={onChange} many={a.type === 'people'} searchUrl={searchUrl} inputId={inputId} words={words} />;
    case 'date':
      return <input type="date" aria-label={label} value={value || ''} onChange={e => onChange(e.target.value)} className={`${INPUT} max-w-[12rem]`} />;
    default:
      return a.maxLength && a.maxLength <= 200
        ? <input aria-label={label} value={value || ''} maxLength={a.maxLength} onChange={e => onChange(e.target.value)} className={INPUT} />
        : <textarea aria-label={label} value={value || ''} maxLength={a.maxLength || 2000} rows={3} onChange={e => onChange(e.target.value)} className={INPUT} />;
  }
}
