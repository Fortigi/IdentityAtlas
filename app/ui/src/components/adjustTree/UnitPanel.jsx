import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { formatDateOnly } from '@ui/utils/formatters';
import { adjustmentsForUnit, byLine, holderLabel, memberDetail, memberWord } from './adjustTree.helpers';
import { AddLevelAboveForm, AddSubUnitForm, MoveForm, RenameForm, SetManagerForm } from './UnitActionForms';
import SplitForm from './SplitForm';

// The Unit tab of the side panel: who manages the selected unit, how many it
// holds, what was adjusted on it, its members, and — for a user who may
// change the tree — the actions, each opening its form below the buttons.

const MEMBER_LIMIT = 100;

const ACTIONS = [
  ['rename', 'Rename'],
  ['move', 'Move under…'],
  ['split', 'Split…'],
  ['addSub', 'Add sub-unit'],
  ['addAbove', 'Add a level above'],
  ['manager', 'Set manager…'],
];

function Fact({ label, children }) {
  return (
    <>
      <dt className="pt-px text-xs uppercase tracking-wide text-gray-600 dark:text-gray-400">{label}</dt>
      <dd className="min-w-0 text-sm text-gray-900 dark:text-gray-100">{children}</dd>
    </>
  );
}

function managerText(unit) {
  const name = unit.accountable?.name || '—';
  if (!unit.interim) return name;
  const until = unit.interim.validUntil ? ` until ${formatDateOnly(unit.interim.validUntil)}` : '';
  return `${name} · ${unit.interim.name} interim${until}`;
}

export default function UnitPanel({ unit, units, treeKey, targetType, adjustments, editable, version, onPost, onGroup }) {
  const { authFetch } = useAuth();
  const [form, setForm] = useState(null);
  const { data, loading } = useFetch(
    `/api/contexts/${encodeURIComponent(unit.id)}/members?limit=${MEMBER_LIMIT}&v=${version}`,
    { authFetch, initialData: { data: [], total: 0 } },
  );
  const members = data?.data || [];
  const mine = adjustmentsForUnit(adjustments, unit.id);
  const word = memberWord(targetType);
  const done = (work) => async (arg) => { if (await work(arg)) setForm(null); };
  const post = done(onPost);
  const group = done(onGroup);
  // Not placed holds the people outside the chosen top: it is not a unit to change.
  const changeable = editable && !unit.notPlaced;

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-gray-900 dark:text-white">{unit.name}</h2>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5">
        <Fact label={holderLabel(unit.contextCategory)}>{managerText(unit)}</Fact>
        <Fact label={word}>{unit.memberCount ?? 0} direct · {unit.totalMemberCount ?? unit.memberCount ?? 0} in total</Fact>
        <Fact label="Adjusted">
          {mine.length === 0
            ? <span className="text-gray-600 dark:text-gray-400">Not adjusted. This unit is exactly as the source has it.</span>
            : (
              <ul className="space-y-0.5">
                {mine.map(a => <li key={a.id}>{a.description} <span className="text-xs text-gray-600 dark:text-gray-400">({byLine(a)})</span></li>)}
              </ul>
            )}
        </Fact>
      </dl>

      {unit.notPlaced && (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          The {word} who are not under the top of the tree: no manager, a manager outside the tree, or a loop of managers.
          {editable && ' Turn on Show ' + word + ' and drag them into a unit.'}
        </p>
      )}
      {changeable && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Change this unit">
          {ACTIONS.map(([key, label]) => (
            <button key={key} type="button" aria-pressed={form === key} onClick={() => setForm(f => (f === key ? null : key))}
              className={`rounded border px-2.5 py-1 text-sm font-medium ${form === key
                ? 'border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-700'
                : 'border-gray-300 bg-white text-blue-700 hover:bg-blue-50 dark:border-gray-600 dark:bg-gray-800 dark:text-blue-300 dark:hover:bg-blue-900/30'}`}>
              {label}
            </button>
          ))}
        </div>
      )}
      {changeable && form && (
        <UnitForm key={`${form}:${unit.id}`} form={form} unit={unit} units={units} treeKey={treeKey} targetType={targetType}
          members={members} onPost={post} onGroup={group} />
      )}

      <div>
        <h3 className="mb-1 text-xs uppercase tracking-wide text-gray-600 dark:text-gray-400">{word} in this unit</h3>
        <MemberList members={members} total={data?.total || 0} loading={loading} word={word} />
      </div>
    </div>
  );
}

const FORMS = {
  rename: (p) => <RenameForm unit={p.unit} onPost={p.onPost} />,
  move: (p) => <MoveForm unit={p.unit} units={p.units} onPost={p.onPost} />,
  split: (p) => <SplitForm unit={p.unit} treeKey={p.treeKey} targetType={p.targetType} members={p.members} onPost={p.onPost} />,
  addSub: (p) => <AddSubUnitForm unit={p.unit} onPost={p.onPost} />,
  addAbove: (p) => <AddLevelAboveForm unit={p.unit} onGroup={p.onGroup} />,
  manager: (p) => <SetManagerForm unit={p.unit} onPost={p.onPost} />,
};

function UnitForm(props) {
  const render = FORMS[props.form];
  return render ? render(props) : null;
}

function MemberList({ members, total, loading, word }) {
  if (loading) return <p className="text-sm text-gray-600 dark:text-gray-400">Loading {word}…</p>;
  if (members.length === 0) return <p className="text-sm text-gray-600 dark:text-gray-400">No {word} directly in this unit.</p>;
  return (
    <ul className="max-h-56 space-y-0.5 overflow-auto">
      {members.map(m => (
        <li key={m.id} className="flex justify-between gap-3 text-sm">
          <span className="text-gray-900 dark:text-gray-100">{m.displayName}</span>
          <span className="truncate text-gray-600 dark:text-gray-400">{memberDetail(m)}</span>
        </li>
      ))}
      {total > members.length && <li className="text-xs text-gray-600 dark:text-gray-400">+{total - members.length} more</li>}
    </ul>
  );
}
