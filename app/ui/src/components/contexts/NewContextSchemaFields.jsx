import { useState } from 'react';
import { attributeLabel } from '@ui/utils/formatters';
import { PersonSearch } from './ContextRoleModal';
import { enumOptions } from './NewContextWizard.helpers';

// Field controls of the plugin parameter form (NewContextSchemaForm.jsx) for
// the parameter shapes beyond text and numbers: a dropdown of allowed values,
// one attribute, and a list of people.

// A dropdown of an `enum` parameter. Options are addressed by position so a
// non-string value (an integer enum) comes back with its own type. Without a
// default the first option is "(not set)", which leaves the parameter out.
export function EnumField({ value, spec, onChange, className }) {
  const options = enumOptions(spec);
  const current = value === undefined ? spec.default : value;
  const index = options.findIndex(o => o.value === current);
  return (
    <select value={index < 0 ? '' : String(index)} onChange={e => onChange(e.target.value === '' ? undefined : options[Number(e.target.value)].value)} className={className}>
      {(index < 0 || spec.default === undefined) && <option value="">(not set)</option>}
      {options.map((o, i) => <option key={String(o.value)} value={String(i)}>{o.label}</option>)}
    </select>
  );
}

// One attribute of the accounts (a string parameter flagged
// "x-attributeSource": "principal"), e.g. what to split units by.
export function AttributeField({ value, options, onChange, className }) {
  const columns = options?.columns || [];
  const extended = options?.extended || [];
  const known = new Set([...columns, ...extended]);
  return (
    <select value={value} onChange={e => onChange(e.target.value || undefined)} className={className}>
      <option value="">(none)</option>
      {value && !known.has(value) && <option value={value}>{value}</option>}
      {columns.length > 0 && (
        <optgroup label="Attributes">
          {columns.map(o => <option key={o} value={o}>{o}</option>)}
        </optgroup>
      )}
      {extended.length > 0 && (
        <optgroup label="Extended attributes">
          {extended.map(o => <option key={o} value={o}>{attributeLabel(o) || o}</option>)}
        </optgroup>
      )}
    </select>
  );
}

// A list of people (an array of account ids): the ones chosen, each with a
// remove cross, and a search to add one. Ids that were set before this form
// opened show as the id until picked again — the form does not look them up.
export function PrincipalListField({ inputId, value, onChange }) {
  const [names, setNames] = useState({});
  function add(p) {
    if (value.includes(p.id)) return;
    setNames(n => ({ ...n, [p.id]: p.displayName }));
    onChange([...value, p.id]);
  }
  return (
    <div className="space-y-1.5">
      {value.length > 0 && (
        <ul aria-label="Chosen people" className="flex flex-wrap gap-1.5">
          {value.map(id => (
            <li key={id} className="inline-flex items-center gap-1 rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200">
              <span>{names[id] || id}</span>
              <button type="button" onClick={() => onChange(value.filter(v => v !== id))} aria-label={`Remove ${names[id] || id}`}
                className="leading-none text-gray-600 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400">✕</button>
            </li>
          ))}
        </ul>
      )}
      <PersonSearch inputId={inputId} label="Add a person" autoFocus={false} onPick={add} />
    </div>
  );
}
