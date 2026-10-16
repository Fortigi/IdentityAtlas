// Organisation → Import wizard: the small presentational pieces every step uses.
//
// Field / SelectField: a <label htmlFor> and its control as SIBLINGS in one
// wrapper — the CrawlerField structure (the e2e contract is
// `label:has-text("X") + input`) plus the htmlFor/id pair CrawlerField lacks,
// so every control has an accessible name.
import { useId } from 'react';
import Select from '@ui/components/inputs/Select';
import { FIELD_INPUT_CLS } from '@ui/components/crawler/wizardFields';

const LABEL_CLS = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';
export const SMALL_BTN_CLS =
  'px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-blue-700 dark:hover:bg-blue-600';
export const LINK_BTN_CLS = 'text-xs text-blue-700 hover:underline dark:text-blue-300';
export const CARD_CLS = 'p-4 border border-gray-200 rounded-lg bg-white dark:bg-gray-800 dark:border-gray-700';
export const CELL_INPUT_CLS =
  'w-full border border-gray-200 rounded px-2 py-1 text-sm bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';
export const START_IMPORT_CLS = 'px-4 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:opacity-50';

export function Field({ label, type = 'text', value, onChange, hint }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLS}>{label}</label>
      <input id={id} type={type} value={value} onChange={e => onChange(e.target.value)} className={FIELD_INPUT_CLS} />
      {hint && <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{hint}</p>}
    </div>
  );
}

export function SelectField({ label, value, onChange, children }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLS}>{label}</label>
      <Select id={id} value={value} onChange={e => onChange(e.target.value)} className={FIELD_INPUT_CLS}>{children}</Select>
    </div>
  );
}

// A compact select for table cells and mapping rows (named by aria-label).
export function CellSelect({ label, value, onChange, options, placeholder }) {
  return (
    <Select aria-label={label} value={value ?? ''} onChange={e => onChange(e.target.value)} className={CELL_INPUT_CLS}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </Select>
  );
}

const NOTICE_CLS = {
  info: 'bg-blue-50 border-blue-200 text-blue-800 dark:bg-blue-900/20 dark:border-blue-700 dark:text-blue-200',
  warning: 'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-900/20 dark:border-amber-700 dark:text-amber-200',
  success: 'bg-green-50 border-green-200 text-green-800 dark:bg-green-900/20 dark:border-green-700 dark:text-green-200',
  error: 'bg-red-50 border-red-200 text-red-700 dark:bg-red-900/20 dark:border-red-700 dark:text-red-300',
};

export function Notice({ variant = 'info', children }) {
  return <div role="status" className={`p-3 border rounded text-sm ${NOTICE_CLS[variant]}`}>{children}</div>;
}

export function Chip({ children }) {
  return (
    <span className="inline-flex items-center text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300">
      {children}
    </span>
  );
}
