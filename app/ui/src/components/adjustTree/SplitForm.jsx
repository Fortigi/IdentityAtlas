import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import ActionForm, { INPUT_CLASS, TextField } from './ActionForm';
import { isPeopleTree, memberDetail, memberWord, withReason } from './adjustTree.helpers';
import { treeUrl } from './useAdjustTree';

// Split… — carve some members out of a unit into a new sub-unit. In a tree of
// people: everyone with one value of an attribute (department "Facilities"),
// from the choices the API counts. Elsewhere — or when there is nothing to
// split by — the members picked one by one, with a name for the new unit.

export default function SplitForm({ unit, treeKey, targetType, members, onPost }) {
  const { authFetch } = useAuth();
  const people = isPeopleTree(targetType);
  const { data: attributes, loading } = useFetch(
    people ? treeUrl(treeKey, `/units/${encodeURIComponent(unit.id)}/split-options`) : null,
    { authFetch, enabled: people, initialData: [], transform: b => b.attributes || [] },
  );
  if (people && loading) return <p className="text-xs text-gray-600 dark:text-gray-400">Loading what this unit can be split by…</p>;
  if (people && attributes.length > 0) return <SplitByValue unit={unit} attributes={attributes} targetType={targetType} onPost={onPost} />;
  return <SplitByMembers unit={unit} members={members} targetType={targetType} onPost={onPost} />;
}

function SplitByValue({ unit, attributes, targetType, onPost }) {
  const [attribute, setAttribute] = useState(attributes[0].attribute);
  const [value, setValue] = useState('');
  const [name, setName] = useState('');
  const values = attributes.find(a => a.attribute === attribute)?.values || [];
  const body = () => {
    const b = { op: 'splitUnit', subjectId: unit.id, attribute, value };
    return name.trim() ? { ...b, name: name.trim() } : b;
  };
  return (
    <ActionForm id="split" submitLabel="Split" canSubmit={value !== ''}
      hint={`The ${memberWord(targetType)} with this value move into a new sub-unit of ${unit.name}. You can move it afterwards.`}
      onSubmit={reason => onPost(withReason(body(), reason))}>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="split-attribute" className="text-xs font-medium text-gray-700 dark:text-gray-300">Split by</label>
        <select id="split-attribute" value={attribute} onChange={e => { setAttribute(e.target.value); setValue(''); }} className={INPUT_CLASS}>
          {attributes.map(a => <option key={a.attribute} value={a.attribute}>{a.label || a.attribute}</option>)}
        </select>
        <label htmlFor="split-value" className="text-xs font-medium text-gray-700 dark:text-gray-300">Value</label>
        <select id="split-value" value={value} onChange={e => setValue(e.target.value)} className={INPUT_CLASS}>
          <option value="">(pick a value)</option>
          {values.map(v => <option key={v.value} value={v.value}>{v.value} ({v.count})</option>)}
        </select>
      </div>
      <TextField id="split-name" label="Name of the new unit" value={name} onChange={setName} placeholder={value || 'the value'} />
    </ActionForm>
  );
}

function SplitByMembers({ unit, members, targetType, onPost }) {
  const [picked, setPicked] = useState(() => new Set());
  const [name, setName] = useState('');
  const word = memberWord(targetType);
  const toggle = (id) => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  if (!members?.length) return <p className="text-xs text-gray-600 dark:text-gray-400">There are no {word} directly in this unit to split off.</p>;
  return (
    <ActionForm id="split" submitLabel="Split" canSubmit={picked.size > 0 && !!name.trim()}
      hint={`Pick the ${word} that move into a new sub-unit of ${unit.name}.`}
      onSubmit={reason => onPost(withReason({ op: 'splitUnit', subjectId: unit.id, memberIds: [...picked], name: name.trim() }, reason))}>
      <fieldset className="max-h-48 space-y-0.5 overflow-auto">
        <legend className="sr-only">{word} to split off</legend>
        {members.map(m => (
          <label key={m.id} className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
            <input type="checkbox" checked={picked.has(m.id)} onChange={() => toggle(m.id)} />
            <span>{m.displayName}</span>
            <span className="text-xs text-gray-600 dark:text-gray-400">{memberDetail(m)}</span>
          </label>
        ))}
      </fieldset>
      <TextField id="split-name" label="Name of the new unit" value={name} onChange={setName} />
    </ActionForm>
  );
}
