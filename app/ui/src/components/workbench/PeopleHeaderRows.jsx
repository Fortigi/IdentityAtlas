import { useState } from 'react';
import { HeaderControls, Chip, Evidence } from './PeopleCells';
import { compactValue } from './workbench.transposed';

// ─── People as columns: what is known of them, as header rows ────────────
// One header row per people column chosen (Job title, Activity, Expertise, Duty,
// …), the display name last, next to the cells — the matrix's attribute rows
// above its subject columns. Each row's label on the left carries the same sort
// and Excel-like filter as the column header has with people as rows; sorting
// orders the people columns. A cell is narrow, so it shows the first value
// written upwards — knowledge with ✓ confirmed / ? proposed / ! disputed — and
// "+2" for more; the hover lists them all, and a click on knowledge opens each
// value's evidence (Confirm / Reject as in the other orientation). The name
// selects what the person holds; "member" people are tinted, as their row is.

const STATE_MARK = { confirmed: '✓', proposed: '?', disputed: '!' };
const VERTICAL = { writingMode: 'vertical-rl', transform: 'rotate(180deg)' };
// A label whose filter is open rises above the labels after it (they are sticky too).
const LABEL = 'sticky left-0 border-b border-r border-gray-200 bg-gray-50 px-2 py-1 text-left align-bottom text-[11px] font-semibold text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200';
const HEIGHT = { name: 'h-32', knowledge: 'h-24' };

function memberBg(member) {
  return member ? 'bg-emerald-50 dark:bg-emerald-950' : 'bg-gray-50 dark:bg-gray-900';
}

function NameCell({ person, member, onPerson }) {
  return (
    <button type="button" onClick={(e) => onPerson(person.key, e)} title={`${person.displayName}${member ? ' — member of the candidate' : ''}\nSelect what this person holds`}
      className={`flex w-full items-end justify-center pb-1 hover:bg-blue-50 dark:hover:bg-blue-900/30 ${HEIGHT.name}`}>
      <span className="max-h-28 overflow-hidden text-ellipsis whitespace-nowrap font-medium text-gray-900 dark:text-gray-100" style={VERTICAL}>{person.displayName}</span>
    </button>
  );
}

// A row nobody shown has a value in stays one line high.
const rowHeight = (column, empty) => (empty ? 'h-5' : HEIGHT[column.type] ?? 'h-20');

function ValueCell({ person, column, empty, personProps, open, onOpenChange }) {
  const { first, more, title } = compactValue(person, column);
  const knowledge = column.type === 'knowledge';
  const text = first ? `${knowledge ? `${STATE_MARK[first.state] ?? ''} ` : ''}${first.label}` : '';
  const body = (
    <span className={`flex w-full flex-col items-center justify-end gap-0.5 pb-1 ${rowHeight(column, empty)}`}>
      <span className={`max-h-20 overflow-hidden text-ellipsis whitespace-nowrap text-[10px] ${first?.state && first.state !== 'confirmed' ? 'text-gray-500 dark:text-gray-400' : 'text-gray-800 dark:text-gray-200'}`} style={VERTICAL}>{text}</span>
      {more > 0 && <span className="rounded bg-gray-200 px-0.5 text-[9px] leading-3 text-gray-700 dark:bg-gray-700 dark:text-gray-200">+{more}</span>}
    </span>
  );
  if (!knowledge || !first) return <div title={title || undefined}>{body}</div>;
  return (
    <div className="relative">
      <button type="button" onClick={() => onOpenChange(!open)} aria-expanded={open} title={title}
        aria-label={`${column.label} of ${person.displayName}: ${title.replace(/\n/g, ', ')}`} className="w-full hover:bg-blue-50 dark:hover:bg-blue-900/30">{body}</button>
      {open && <KnowledgePopover person={person} column={column} personProps={personProps} onClose={() => onOpenChange(false)} />}
    </div>
  );
}

// All of a person's values for one kind, each opening its evidence.
function KnowledgePopover({ person, column, personProps, onClose }) {
  const [link, setLink] = useState(null);
  const { values } = compactValue(person, column);
  return (
    <div role="dialog" aria-label={`${column.label} of ${person.displayName}`}
      className="absolute left-0 top-full z-50 mt-1 w-72 rounded border border-gray-200 bg-white p-2 text-left text-[11px] font-normal shadow-lg dark:border-gray-600 dark:bg-gray-900">
      <div className="flex items-start justify-between gap-2">
        <span className="font-semibold text-gray-900 dark:text-gray-100">{column.label} · {person.displayName}</span>
        <button type="button" onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100">✕</button>
      </div>
      <div className="mt-1 flex flex-wrap gap-0.5">
        {values.map(v => <Chip key={v.value} link={v.link} open={link === v.link} onToggle={() => setLink(link === v.link ? null : v.link)} />)}
      </div>
      {link && <div className="relative"><Evidence link={link} onDecide={personProps.onDecide} busy={personProps.busy} onClose={() => setLink(null)} /></div>}
    </div>
  );
}

/**
 * @param {object}   props
 * @param {object[]} props.columns     the header rows (headerColumns: attributes, the name last)
 * @param {object[]} props.people      the people shown, in column order
 * @param {object}   props.header      { allPeople, filters, sort, onSort, onFilter } — as the people-as-rows header takes
 * @param {number}   props.labelSpan   how many row-label columns the label spans
 * @param {Set}      props.members     the candidate's members (tinted)
 * @param {Function} props.onPerson    (personKey, event) select what they hold
 * @param {object}   props.personProps { onDecide, busy } for the evidence
 */
export default function PeopleHeaderRows({ columns, people, header, labelSpan, members, onPerson, personProps }) {
  const [open, setOpen] = useState(null);
  return columns.map(column => {
    const empty = column.type !== 'name' && people.every(p => compactValue(p, column).first === null);
    return (
      <tr key={column.key} data-empty={empty || undefined}>
        <th scope="row" colSpan={labelSpan} className={LABEL} style={{ zIndex: open === column.key ? 50 : 30 }}>
          <HeaderControls column={column} people={header.allPeople} filter={header.filters[column.key]} sort={header.sort}
            onSort={header.onSort} onFilter={header.onFilter} open={open === column.key} onOpenChange={(v) => setOpen(v ? column.key : null)} />
        </th>
        {people.map(person => {
          const cellOpen = open === `${column.key}|${person.key}`;
          return (
            <th key={person.key} scope="col" className={`relative w-6 min-w-[1.5rem] max-w-[1.5rem] border-b border-r border-gray-100 p-0 align-bottom font-normal dark:border-gray-700 ${memberBg(members.has(person.key))} ${cellOpen ? 'z-40' : ''}`}>
              {column.type === 'name'
                ? <NameCell person={person} member={members.has(person.key)} onPerson={onPerson} />
                : <ValueCell person={person} column={column} empty={empty} personProps={personProps} open={cellOpen} onOpenChange={(v) => setOpen(v ? `${column.key}|${person.key}` : null)} />}
            </th>
          );
        })}
      </tr>
    );
  });
}
