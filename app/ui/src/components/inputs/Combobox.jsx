import { useState, useRef, useEffect } from 'react';
import ChevronDown from './ChevronDown';

// A free-text input with a clickable dropdown of live suggestions, sharing the same
// ChevronDown symbol as Select. Designed for midPoint mapping fields:
//   - the chevron (or focus) opens the list;
//   - `options` are the values discovered live from midPoint (may be empty);
//   - `defaultOption` ({ value, label }) is ALWAYS shown first, so an empty list still
//     offers the default/catch-all value;
//   - typing is always allowed (free text) — the field keeps whatever you type.
//
// Props:
//   value, onChange(string)      — controlled value
//   options: string[]            — live suggestions
//   defaultOption: {value,label} — always-present first row (e.g. the catch-all)
//   placeholder, id
//   className        — visual classes for the <input>
//   wrapperClassName — layout classes for the wrapper (e.g. "flex-1 min-w-0")
export default function Combobox({
  value,
  onChange,
  options = [],
  defaultOption,
  placeholder,
  id,
  className = '',
  wrapperClassName = '',
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocMouseDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  // Default row always pinned first; then the live options filtered by the typed
  // substring and shown in alphabetical (case-insensitive, locale-aware) order.
  const q = (value || '').toLowerCase();
  const rows = [];
  if (defaultOption) rows.push({ value: defaultOption.value, label: defaultOption.label, isDefault: true });
  const matches = options.filter(o => o && !(defaultOption && o === defaultOption.value) && o.toLowerCase().includes(q));
  matches.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  for (const o of matches) rows.push({ value: o, label: o, isDefault: false });

  const choose = (v) => { onChange(v); setOpen(false); setActive(-1); };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter' && open && active >= 0 && active < rows.length) { e.preventDefault(); choose(rows[active].value); }
    else if (e.key === 'Escape') { setOpen(false); setActive(-1); }
  };

  return (
    <div ref={ref} className={`relative ${wrapperClassName}`}>
      <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className={`w-full pr-8 ${className}`}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label="Toggle suggestions"
        onClick={() => setOpen((o) => !o)}
        className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      >
        <ChevronDown />
      </button>
      {open && (
        <ul className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded border border-gray-200 bg-white py-1 text-sm shadow-lg dark:border-gray-600 dark:bg-gray-700">
          {rows.map((r, idx) => (
            <li
              key={`${r.value}-${idx}`}
              onMouseDown={(e) => { e.preventDefault(); choose(r.value); }}
              onMouseEnter={() => setActive(idx)}
              className={`cursor-pointer px-2 py-1 ${idx === active ? 'bg-blue-50 dark:bg-blue-900/30' : ''} ${
                r.isDefault ? 'italic text-gray-500 dark:text-gray-400' : 'text-gray-800 dark:text-gray-200'
              }`}
            >
              {r.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
