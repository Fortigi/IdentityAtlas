// Shared crawler-wizard field primitives.
//
// Every crawler wizard was repeating the same markup per field — a wrapper div
// holding a <label>, an <input>, and an optional hint — and the same radio /
// checkbox option lists. jscpd counted the copies as clones across the omada,
// midPoint and SCIM wizards, and the duplication-delta gate refuses new ones.
// This is the view half of the split that @ui/utils/crawlerCredentials already
// made for the logic half.
//
// STRUCTURE IS PART OF THE CONTRACT: the <label> and its control stay SIBLINGS
// inside the wrapper. The crawler e2e tests select fields with
// `label:has-text("Username") + input`, so nesting the input inside the label
// would silently break every wizard's end-to-end coverage.

export const FIELD_INPUT_CLS =
  'w-full border border-gray-200 rounded px-3 py-2 text-sm bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';
export const FIELD_MONO_CLS = FIELD_INPUT_CLS + ' font-mono';
export const WIZARD_NEXT_CLS =
  'px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed';
export const WIZARD_BACK_CLS =
  'px-4 py-2 bg-gray-100 text-gray-700 rounded text-sm hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300';

const LABEL_CLS = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';
const HINT_CLS = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

// One labelled wizard input. `onChange` receives the VALUE, not the event —
// every call site only ever wanted e.target.value.
export function CrawlerField({ label, optional, hint, mono, type = 'text', value, onChange, placeholder }) {
  return (
    <div>
      <label className={LABEL_CLS}>
        {label}
        {optional && <span className="font-normal text-gray-500"> (optional)</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        className={mono ? FIELD_MONO_CLS : FIELD_INPUT_CLS}
        placeholder={placeholder}
      />
      {hint && <p className={HINT_CLS}>{hint}</p>}
    </div>
  );
}

// A list of `{ id|key, label, description }` options as radios (single choice)
// or checkboxes (multi). Same markup either way — label, muted description —
// which is why both the auth-method picker and the object-type picker were
// independently reproducing it in each wizard.
export function OptionList({ options, type = 'radio', name, selected, onSelect, grid }) {
  const isChecked = opt => (type === 'radio' ? selected === (opt.id ?? opt.key) : !!selected[opt.id ?? opt.key]);
  return (
    <div className={grid ? 'grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2' : 'space-y-2'}>
      {options.map(opt => {
        const key = opt.id ?? opt.key;
        return (
          <label key={key} className="flex items-start gap-3 cursor-pointer">
            <input
              type={type}
              name={name}
              value={key}
              checked={isChecked(opt)}
              onChange={e => onSelect(key, e.target.checked)}
              className="mt-0.5"
            />
            <div>
              <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{opt.label}</span>
              <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">{opt.description}</span>
            </div>
          </label>
        );
      })}
    </div>
  );
}

// The Back / Next (or Save) row that closes every wizard step.
export function WizardNav({ onBack, onNext, nextDisabled, nextLabel = 'Next →', nextCls, children }) {
  return (
    <div className={onBack ? 'flex justify-between' : 'flex justify-end'}>
      {onBack && <button onClick={onBack} className={WIZARD_BACK_CLS}>← Back</button>}
      {children}
      {onNext && (
        <button onClick={onNext} disabled={nextDisabled} className={nextCls || WIZARD_NEXT_CLS}>
          {nextLabel}
        </button>
      )}
    </div>
  );
}
