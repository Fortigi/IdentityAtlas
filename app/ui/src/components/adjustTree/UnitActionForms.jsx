import { useState } from 'react';
import { PersonSearch } from '@ui/components/contexts/ContextRoleModal';
import ActionForm, { INPUT_CLASS, TextField } from './ActionForm';
import { moveTargets, withReason } from './adjustTree.helpers';

// The forms behind the unit panel's actions. Each builds one adjustment (or,
// for Add a level above, a new unit with this unit moved under it) and hands
// it to the page: `onPost(body)` posts one adjustment, `onGroup(spec)` adds a
// unit and moves units under it. Both resolve once the tree is re-read.

export function RenameForm({ unit, onPost }) {
  const [name, setName] = useState(unit.name);
  const clean = name.trim();
  return (
    <ActionForm id="rename" submitLabel="Rename" canSubmit={!!clean && clean !== unit.name}
      onSubmit={reason => onPost(withReason({ op: 'renameUnit', subjectId: unit.id, name: clean }, reason))}>
      <TextField id="rename-name" label="New name" value={name} onChange={setName} />
    </ActionForm>
  );
}

// The keyboard way to move a unit (the tree's drag is pointer-only).
export function MoveForm({ unit, units, onPost }) {
  const targets = moveTargets(units, unit.id);
  const [to, setTo] = useState('');
  const atTop = unit.parentId == null;
  return (
    <ActionForm id="move" submitLabel="Move" canSubmit={to !== ''}
      hint="Its sub-units and members move with it."
      onSubmit={reason => onPost(withReason({ op: 'moveUnit', subjectId: unit.id, toParentId: to === 'top' ? null : to }, reason))}>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="move-to" className="text-xs font-medium text-gray-700 dark:text-gray-300">Move under</label>
        <select id="move-to" value={to} onChange={e => setTo(e.target.value)} className={INPUT_CLASS}>
          <option value="">(pick a unit)</option>
          {!atTop && <option value="top">Top level</option>}
          {targets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
    </ActionForm>
  );
}

export function AddSubUnitForm({ unit, onPost }) {
  const [name, setName] = useState('');
  return (
    <ActionForm id="add-sub" submitLabel="Add" canSubmit={!!name.trim()}
      hint={`A new unit under ${unit.name}. Drag units or members into it afterwards.`}
      onSubmit={reason => onPost(withReason({ op: 'addUnit', parentId: unit.id, name: name.trim() }, reason))}>
      <TextField id="add-sub-name" label="Name of the new unit" value={name} onChange={setName} />
    </ActionForm>
  );
}

// A new unit where this one is now, with this unit moved under it — e.g. a
// "Board" above the CEO's unit.
export function AddLevelAboveForm({ unit, onGroup }) {
  const [name, setName] = useState('');
  return (
    <ActionForm id="add-above" submitLabel="Add level" canSubmit={!!name.trim()}
      hint={`A new unit takes the place of ${unit.name}, and ${unit.name} moves under it.`}
      onSubmit={reason => onGroup({ name: name.trim(), parentId: unit.parentId ?? null, unitIds: [unit.id], reason })}>
      <TextField id="add-above-name" label="Name of the new unit" value={name} onChange={setName} />
    </ActionForm>
  );
}

// Put the picked units under one new unit, at the level they share (or the
// top level when they sit in different places).
export function GroupForm({ count, parentName, onGroup }) {
  const [name, setName] = useState('');
  const where = parentName ? `under ${parentName}` : 'at the top level';
  return (
    <ActionForm id="group" submitLabel="Group" canSubmit={!!name.trim()}
      hint={`A new unit ${where}, with the ${count} picked unit${count === 1 ? '' : 's'} moved under it.`}
      onSubmit={reason => onGroup(name.trim(), reason)}>
      <TextField id="group-name" label="Name of the new unit" value={name} onChange={setName} />
    </ActionForm>
  );
}

// Who manages the unit; optionally only for a while (interim, until a date).
export function SetManagerForm({ unit, onPost }) {
  const [person, setPerson] = useState(null);
  const [interim, setInterim] = useState(false);
  const [until, setUntil] = useState('');
  const body = () => {
    const b = { op: 'setManager', subjectId: unit.id, principalId: person.id, interim };
    return interim && until ? { ...b, validUntil: until } : b;
  };
  return (
    <ActionForm id="manager" submitLabel="Set manager" canSubmit={!!person}
      hint="An interim manager is temporary: when the date passes, the change shows up for review."
      onSubmit={reason => onPost(withReason(body(), reason))}>
      <PersonSearch inputId="manager-search" label="Find a person" onPick={setPerson} />
      {person && <p className="text-sm text-gray-700 dark:text-gray-300">New manager: <span className="font-medium text-gray-900 dark:text-white">{person.displayName}</span></p>}
      <div className="flex flex-wrap items-center gap-3 text-sm text-gray-700 dark:text-gray-300">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={interim} onChange={e => setInterim(e.target.checked)} /> Interim
        </label>
        {interim && (
          <label className="flex items-center gap-1.5">
            Until
            <input type="date" value={until} onChange={e => setUntil(e.target.value)} className={INPUT_CLASS} />
          </label>
        )}
      </div>
    </ActionForm>
  );
}
