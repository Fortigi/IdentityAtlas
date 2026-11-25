// The per-file controls of the CSV crawler wizard: object-type and delimiter
// pickers, the column-mapping panel, and the review-step summary line.
//
// Split out of ConfigWizard.jsx so that stays orchestration (steps, staging,
// save) rather than growing a second screen's worth of form inside it. All the
// rules live in csvMapping.js; this file only renders them.
//
// The panel is a native <details>, so it needs no open/closed state of its own
// and is keyboard-operable and screen-reader-announced for free. Every select
// gets an accessible name that includes the file name — there can be a dozen
// identical-looking dropdowns on screen, and "Column for DisplayName" alone
// does not say which file it belongs to.

import { useState } from 'react';
import CSV_SLOTS from './csv-slots.json';
import {
  DELIMITER_CANDIDATES,
  delimiterLabel,
  schemaColumnsFor,
  slotDef,
  extraColumnsNote,
  canSplitField,
  mappedPairs,
  normalizeDelimiter,
  SPLITTABLE_FIELDS,
} from './csvMapping.js';

// The delimiters a file may be read with: the auto-detected candidates plus
// pipe, which stays manually selectable but is never auto-detected (a pipe
// inside one free-text column would outvote the real delimiter far too easily).
const SELECTABLE_DELIMITERS = [...DELIMITER_CANDIDATES, '|'];

const SELECT_CLASS = 'text-xs border border-gray-200 rounded px-1 py-0.5 dark:bg-gray-700 dark:text-gray-200 dark:border-gray-600';

// One file's delimiter. Pre-set to what detection found and labelled as
// detected, so the wizard shows what it chose rather than applying it silently
// — and it is a plain select, so overriding it is one click.
export function DelimiterSelect({ fileName, value, detected, onChange }) {
  const current = normalizeDelimiter(value);
  return (
    <select
      value={current}
      onChange={e => onChange(e.target.value)}
      aria-label={`CSV delimiter for ${fileName}`}
      className={`ml-2 ${SELECT_CLASS}`}
    >
      {SELECTABLE_DELIMITERS.map(d => (
        <option key={d} value={d}>
          {delimiterLabel(d)}{normalizeDelimiter(detected) === d ? ' — detected' : ''}
        </option>
      ))}
    </select>
  );
}

// One schema field's row: a dropdown of the file's real columns, plus (on the
// Assignments slot's two identifying fields) the "split values on" input.
function FieldRow({ fileName, slotKey, field, required, headerCols, mapping, splitDelimiters, splitOwner, onChange }) {
  const selected = mapping?.[field] || '';
  const splitValue = splitDelimiters?.[field] || '';
  // One split per file (#1688 D6): the other field's input is disabled while a
  // split is set, so a cartesian product can't be configured in the first place.
  const splitBlocked = !!splitOwner && splitOwner !== field;
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className={`w-48 shrink-0 text-xs ${required ? 'font-semibold' : ''} ${selected ? 'text-gray-700 dark:text-gray-200' : 'text-gray-500 dark:text-gray-400'}`}>
        {field}{required ? ' *' : ''}
      </span>
      <select
        value={selected}
        onChange={e => onChange({ mapping: { ...(mapping || {}), [field]: e.target.value } })}
        aria-label={`Source column for ${field} in ${fileName}`}
        className={`${SELECT_CLASS} ${required && !selected ? 'border-red-400 dark:border-red-500' : ''}`}
      >
        <option value="">— unmapped —</option>
        {headerCols.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
      {canSplitField(slotKey, field) && (
        <label className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
          Split values on
          <input
            type="text"
            value={splitValue}
            maxLength={2}
            disabled={splitBlocked}
            onChange={e => onChange({ splitDelimiters: { [field]: e.target.value } })}
            aria-label={`Multi-value split delimiter for ${field} in ${fileName}`}
            placeholder="none"
            className="w-14 px-1 py-0.5 border border-gray-200 rounded font-mono dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500 disabled:opacity-40"
          />
        </label>
      )}
    </div>
  );
}

// The mapping panel for one file: one row per schema field of its slot, each a
// dropdown of the file's real header columns.
//
// Open by default — in custom mode the mapping IS the step, and a collapsed
// panel hides exactly the thing the admin came to check. Collapsing one sticks:
// `open` is state here, so a re-render from editing another file does not
// re-expand it.
export default function MappingEditor({ fileName, slotKey, headerCols, mapping, splitDelimiters, errors = [], onChange }) {
  const [open, setOpen] = useState(true);
  const def = slotDef(slotKey);
  if (!def) return null;
  const fields = schemaColumnsFor(slotKey);
  const required = new Set((def.requiredColumns || []).map(c => c.toLowerCase()));
  const mappedCount = mappedPairs(mapping).length;
  const splitOwner = SPLITTABLE_FIELDS.find(f => (splitDelimiters || {})[f]);

  return (
    <details open={open} onToggle={e => setOpen(e.currentTarget.open)}
      className="mt-1 border border-gray-200 rounded dark:border-gray-600">
      <summary className="px-2 py-1 text-xs cursor-pointer text-gray-700 dark:text-gray-300">
        Map columns — {mappedCount} of {fields.length} {def.label} field{fields.length === 1 ? '' : 's'} mapped
        {errors.length > 0 && <span className="ml-2 text-red-600 dark:text-red-400">· needs attention</span>}
      </summary>
      <div className="px-2 pb-2">
        {headerCols.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">Reading this file&apos;s columns…</p>
        ) : (
          <>
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {fields.map(field => (
                <FieldRow
                  key={field}
                  fileName={fileName}
                  slotKey={slotKey}
                  field={field}
                  required={required.has(field.toLowerCase())}
                  headerCols={headerCols}
                  mapping={mapping}
                  splitDelimiters={splitDelimiters}
                  splitOwner={splitOwner}
                  onChange={onChange}
                />
              ))}
            </div>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{extraColumnsNote(slotKey)}</p>
          </>
        )}
      </div>
    </details>
  );
}

// Which schema slot a file feeds. "— Ignore —" leaves it out of the config
// entirely: nothing reads it.
export function SlotSelect({ fileName, slot, invalid, onChange }) {
  return (
    <select value={slot || ''} onChange={e => onChange(e.target.value || null)}
      aria-label={`Object type for ${fileName}`}
      className={`ml-2 text-xs border rounded px-1 py-0.5 dark:bg-gray-700 dark:text-gray-200 ${invalid ? 'border-red-400 dark:border-red-500' : 'border-gray-200 dark:border-gray-600'}`}>
      <option value="">— Ignore —</option>
      {CSV_SLOTS.map(s => (
        <option key={s.key} value={s.key}>{s.label}{s.required ? ' *' : ''}</option>
      ))}
    </select>
  );
}

// Everything below one file's row: its delimiter, its mapping panel (custom mode
// only) and whatever is wrong with it. Used for staged and already-uploaded
// files alike — a delimiter and a mapping are properties of the file, not of how
// it got here.
export function FileSettings({ fileName, settings, headerCols, errors, mappingEnabled, onDelimiterChange, onPatch }) {
  return (
    <>
      <div className="mt-1 flex items-center text-xs text-gray-500 dark:text-gray-400">
        <span>Delimiter{settings.detected ? ` (${delimiterLabel(settings.detected)} detected)` : ''}:</span>
        <DelimiterSelect fileName={fileName} value={settings.delimiter} detected={settings.detected}
          onChange={onDelimiterChange} />
      </div>
      {mappingEnabled && settings.slot && (
        <MappingEditor
          fileName={fileName}
          slotKey={settings.slot}
          headerCols={headerCols}
          mapping={settings.mapping}
          splitDelimiters={settings.splitDelimiters}
          errors={errors}
          onChange={onPatch}
        />
      )}
      {errors.map(msg => (
        <div key={msg} className="mt-1 text-xs text-red-700 dark:text-red-300" role="alert">{msg}</div>
      ))}
    </>
  );
}

// The review step's per-file line: what the crawler will actually do with each
// file, before anything is saved.
export function FileReviewList({ files, settingsFor, mappingEnabled }) {
  if (files.length === 0) return null;
  return (
    <ul className="border border-gray-200 rounded divide-y text-xs dark:border-gray-600 dark:divide-gray-700">
      {files.map(f => {
        const s = settingsFor(f.name);
        const mapped = mappedPairs(s.mapping).length;
        const split = Object.entries(s.splitDelimiters || {}).find(([, d]) => d);
        return (
          <li key={`${f.source}-${f.name}`} className="p-2 dark:bg-gray-800 dark:text-gray-300">
            <span className="font-mono">{f.name}</span>
            <span className="text-gray-500 dark:text-gray-400">
              {' · '}{slotDef(f.slot)?.label || 'Ignored'}
              {' · '}{delimiterLabel(s.delimiter)}
              {mappingEnabled && f.slot ? ` · ${mapped} mapped column${mapped === 1 ? '' : 's'}` : ''}
              {split ? ` · splits ${split[0]} on "${split[1]}"` : ''}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
