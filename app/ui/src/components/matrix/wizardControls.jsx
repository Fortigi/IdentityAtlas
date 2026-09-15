// Small form controls shared by the Matrix wizard's steps (#1202).
//
// Each step opens with one choice (what are the rows, what are the columns, how
// does it read), so the controls that express a choice live here once rather
// than being re-styled per step.

import { useId, useState } from 'react';

// One selectable card of an either/or choice. `aria-pressed` carries the state,
// so the choice is readable without the colour.
export function ChoiceCard({ active, onClick, title, description }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`w-full text-left border rounded-lg p-3 transition-colors ${
        active
          ? 'border-blue-500 dark:border-blue-400 bg-blue-50/50 dark:bg-blue-900/20'
          : 'border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500'
      }`}
    >
      <div className="flex items-start gap-2">
        <span className={`w-3 h-3 mt-1 rounded-full border-2 flex-shrink-0 ${
          active
            ? 'border-blue-500 dark:border-blue-400 bg-blue-500 dark:bg-blue-400'
            : 'border-gray-300 dark:border-gray-500'
        }`} />
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-gray-900 dark:text-white">{title}</h4>
          {description && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{description}</p>}
        </div>
      </div>
    </button>
  );
}

// A question heading plus a row of choice cards.
export function ChoiceGroup({ heading, options, value, onChange, columns = 2 }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400 mb-2">{heading}</h4>
      <div className={`grid gap-2 ${columns === 2 ? 'sm:grid-cols-2' : ''}`}>
        {options.map(o => (
          <ChoiceCard
            key={o.key}
            active={value === o.key}
            onClick={() => onChange(o.key)}
            title={o.title}
            description={o.description}
          />
        ))}
      </div>
    </div>
  );
}

// One opt-in checkbox: a real <label>, so the box is reachable by its accessible
// name, with the explanation as help text under it.
export function CheckboxToggle({ label, checked, onChange, children }) {
  return (
    <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
      <input
        type="checkbox"
        className="mt-0.5 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {children && <span className="block text-xs text-gray-500 dark:text-gray-400">{children}</span>}
      </span>
    </label>
  );
}

// A collapsed section behind a button ("More options", "Add a description").
export function Disclosure({ label, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(o => !o)}
        className="text-xs text-blue-700 dark:text-blue-300 hover:underline"
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> {label}
      </button>
      {open && <div id={id} className="mt-2">{children}</div>}
    </div>
  );
}

// A segmented single choice (All / Governed / …), announced as a group.
export function SegmentedControl({ label, options, value, onChange }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded border border-gray-200 dark:border-gray-600 overflow-hidden">
      {options.map(o => (
        <button
          key={o.key}
          type="button"
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
          className={`px-2.5 py-1 text-xs border-r last:border-r-0 border-gray-200 dark:border-gray-600 ${
            value === o.key
              ? 'bg-blue-600 text-white dark:bg-blue-700'
              : 'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700/50'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// A section heading inside a step.
export function SectionHeading({ children, hint }) {
  return (
    <div className="mb-2">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400">{children}</h4>
      {hint && <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
    </div>
  );
}
