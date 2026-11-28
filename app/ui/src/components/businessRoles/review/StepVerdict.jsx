import { VERDICT_INFO } from './reviewSteps';

// ─── The reviewer's verdict on one step ──────────────────────────────────
// Three choices, always the same: good, needs a change, or "I do not understand
// what I am reading". The last two open a field: what should change, or the
// reviewer's question. `children` sit between the choices and that field (the
// ownership step puts its people picker there).

const CHOICE = 'flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm';
const CHOSEN = 'border-blue-600 bg-blue-50 text-gray-900 dark:border-blue-400 dark:bg-blue-900/30 dark:text-white';
const IDLE = 'border-gray-300 text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700/50';

export default function StepVerdict({ step, question, verdicts, answer, onChange, children }) {
  const info = VERDICT_INFO[answer.verdict];
  return (
    <fieldset className="space-y-3 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800" data-testid={`verdict-${step}`}>
      <legend className="px-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{question}</legend>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        {verdicts.map(v => (
          <label key={v} className={`${CHOICE} ${answer.verdict === v ? CHOSEN : IDLE}`}>
            <input type="radio" name={`verdict-${step}`} value={v} checked={answer.verdict === v}
              onChange={() => onChange({ ...answer, verdict: v })} className="mt-0.5" />
            <span>{VERDICT_INFO[v]?.label ?? v}</span>
          </label>
        ))}
      </div>
      {answer.verdict === 'needsChange' && children}
      {info?.remarkLabel && (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-gray-900 dark:text-gray-100">{info.remarkLabel}</span>
          <textarea value={answer.remark} onChange={e => onChange({ ...answer, remark: e.target.value })} rows={3} maxLength={4000}
            placeholder={info.placeholder}
            className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500" />
        </label>
      )}
    </fieldset>
  );
}
