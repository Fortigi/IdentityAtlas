import JsonSchemaForm from './NewContextSchemaForm';
import { AttributeField } from './NewContextSchemaFields';
import { peoplePreset, presetFilters, incompletePeopleRule, pickSchema, orgMoreOptionsSchema } from './NewContextWizard.helpers';

// The guided steps of an organisation tree built from the manager chain:
// who is in it, where a manager sits, and what a team is called.
const INPUT = 'w-full border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600';

const CONDITIONS = [
  ['isNotNull', 'has a value'],
  ['equals', 'is'],
  ['notEquals', 'is not'],
  ['inValues', 'is one of (comma separated)'],
  ['notMatches', 'does not match pattern'],
];

export default function OrgSetupStep({ orgStep, ...props }) {
  if (orgStep === 'people') return <PeopleStep {...props} />;
  if (orgStep === 'managers') return <ManagersStep {...props} />;
  return <NamesStep {...props} />;
}

function Choice({ name, checked, onSelect, title, help }) {
  return (
    <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
      <input type="radio" name={name} checked={checked} onChange={onSelect} className="mt-0.5" />
      <span>
        {title}
        <span className="block text-[11px] text-gray-500 dark:text-gray-400">{help}</span>
      </span>
    </label>
  );
}

function RuleField({ label, children }) {
  return (
    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
      {label}
      {children}
    </label>
  );
}

function Check({ checked, onChange, title, help }) {
  return (
    <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="mt-0.5" />
      <span>
        {title}
        <span className="block text-[11px] text-gray-500 dark:text-gray-400">{help}</span>
      </span>
    </label>
  );
}

function PeopleStep({ selected, params, setParams, systems, principalAttrs, dryRunning, dryResult, onDryRun }) {
  const set = (patch) => setParams({ ...params, ...patch });
  const preset = peoplePreset(params.peopleFilters);
  const rule = params.peopleFilters?.[0];
  return (
    <div className="space-y-4">
      <JsonSchemaForm schema={pickSchema(selected?.parametersSchema, ['scopeSystemId'])} values={params} onChange={setParams} systems={systems} principalAttrs={principalAttrs} />

      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-semibold text-gray-700 dark:text-gray-300">Who belongs in this organisation?</legend>
        <Choice name="org-people" checked={preset === 'hr'} onSelect={() => set({ peopleFilters: presetFilters('hr') })}
          title="People managed by HR" help="Accounts with an employee ID. Leaves out most admin, service and shared accounts." />
        <Choice name="org-people" checked={preset === 'custom'} onSelect={() => set({ peopleFilters: presetFilters('custom') })}
          title="A rule of my own" help="For when HR marks people in another attribute, such as employee type." />
        {preset === 'custom' && <RuleEditor rule={rule} attrs={principalAttrs} onChange={r => set({ peopleFilters: [r] })} />}
        <Choice name="org-people" checked={preset === 'all'} onSelect={() => set({ peopleFilters: [] })}
          title="Every account" help="Admin and other non-personal accounts then show up as team members." />
      </fieldset>

      <div className="space-y-2">
        <Check checked={params.excludeSecondAccounts === true} onChange={v => set({ excludeSecondAccounts: v })}
          title="Leave out people's own second accounts" help="An account whose manager has the same employee ID, such as someone's admin account." />
        <Check checked={params.excludeInactive === true} onChange={v => set({ excludeInactive: v })}
          title="Leave out disabled accounts" help="Leavers do not appear in the organisation." />
      </div>

      <PeopleCount canCount={!!params.scopeSystemId && !incompletePeopleRule(params.peopleFilters)} dryRunning={dryRunning} stats={dryResult?.stats} onCount={onDryRun} />
    </div>
  );
}

function RuleEditor({ rule, attrs, onChange }) {
  const r = rule || { attribute: '', condition: 'isNotNull' };
  const isList = r.condition === 'inValues';
  return (
    <div className="ml-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
      <RuleField label="Attribute">
        <AttributeField value={r.attribute || ''} options={attrs} className={INPUT} onChange={v => onChange({ ...r, attribute: v || '' })} />
      </RuleField>
      <RuleField label="Condition">
        <select value={r.condition} className={INPUT} onChange={e => onChange({ attribute: r.attribute, condition: e.target.value })}>
          {CONDITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </RuleField>
      {r.condition !== 'isNotNull' && (
        <div className="sm:col-span-2">
          <RuleField label="Value">
            <input className={INPUT} value={isList ? (r.values || []).join(', ') : (r.value || '')}
              onChange={e => onChange(isList
                ? { ...r, values: e.target.value.split(',').map(s => s.trimStart()) }
                : { ...r, value: e.target.value })} />
          </RuleField>
        </div>
      )}
    </div>
  );
}

function PeopleCount({ canCount, dryRunning, stats, onCount }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-gray-200 bg-gray-50 p-2 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-700/50 dark:text-gray-300">
      <span role="status">
        {stats
          ? `${stats.peopleIncluded} of ${stats.accountsTotal} accounts are in. Left out: ${stats.filteredOut} by the rule, ${stats.secondAccounts} second accounts.`
          : 'Check how many accounts this keeps.'}
      </span>
      <button type="button" onClick={onCount} disabled={!canCount || dryRunning} className="shrink-0 text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400">
        {dryRunning ? 'Counting…' : 'Count people'}
      </button>
    </div>
  );
}

function ManagersStep({ params, setParams }) {
  const placement = params.managerPlacement || 'reportsUp';
  const set = (managerPlacement) => setParams({ ...params, managerPlacement });
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-xs font-semibold text-gray-700 dark:text-gray-300">Is a manager part of the team they manage?</legend>
      <Choice name="org-manager" checked={placement === 'ownTeam'} onSelect={() => set('ownTeam')}
        title="Yes, in the team they manage" help="The Finance manager is a member of Finance." />
      <Choice name="org-manager" checked={placement === 'reportsUp'} onSelect={() => set('reportsUp')}
        title="No, in the team above" help="The Finance manager is a member of the team of their own manager, and still answers for Finance." />
    </fieldset>
  );
}

function NamesStep({ selected, params, setParams, systems, principalAttrs }) {
  const nameFrom = params.nameFrom || 'manager';
  const schema = selected?.parametersSchema;
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-semibold text-gray-700 dark:text-gray-300">What is a team called?</legend>
        <Choice name="org-name" checked={nameFrom === 'manager'} onSelect={() => setParams({ ...params, nameFrom: 'manager' })}
          title="After the manager's attribute" help="Uses the manager's own department." />
        <Choice name="org-name" checked={nameFrom === 'members'} onSelect={() => setParams({ ...params, nameFrom: 'members' })}
          title="After what the team members share" help="Uses the value most of the team has. A CFO in the Board department then still leads “Finance”." />
      </fieldset>
      <JsonSchemaForm schema={pickSchema(schema, ['nameFields', 'includeManagerName'])} values={params} onChange={setParams} systems={systems} principalAttrs={principalAttrs} />
      <details>
        <summary className="cursor-pointer text-xs font-semibold text-gray-700 dark:text-gray-300">More options</summary>
        <div className="mt-2 space-y-3">
          <JsonSchemaForm schema={orgMoreOptionsSchema(schema)} values={params} onChange={setParams} systems={systems} principalAttrs={principalAttrs} />
        </div>
      </details>
    </div>
  );
}
