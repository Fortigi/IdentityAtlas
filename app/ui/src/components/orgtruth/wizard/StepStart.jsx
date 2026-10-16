// Import wizard step 1 — Start: a new import, or repeat an earlier import
// profile (GET /profiles?latest=1: the newest version per name; a 501 reads as
// "no profiles yet") as a full or delta run, optionally
// adjusting its configuration. Presentational: every edit goes through
// wizardDraft.js.
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { OptionList, WizardNav } from '@ui/components/crawler/wizardFields';
import { emptyDraft, latestProfiles, selectProfile, setMode, stepReady } from './wizardDraft';
import { API, asList } from './wizardApi';
import { Notice, SelectField } from './wizardUi';

const MODE_OPTIONS = [
  { id: 'new', label: 'New import', description: 'upload a list and describe what its columns mean' },
  { id: 'repeat', label: 'Repeat an earlier import', description: 'upload a newer version of a list you imported before' },
];

const RUN_MODE_OPTIONS = [
  { id: 'full', label: 'Full', description: 'the list is complete: what it no longer contains is closed' },
  { id: 'delta', label: 'Delta', description: 'the list holds changes only: nothing outside it is touched' },
];

const NO_PROFILES = 'There is no earlier import to repeat yet. Start a new import.';

function ProfilePicker({ draft, update }) {
  const { authFetch } = useAuth();
  const { data: profiles, loading, error } = useFetch(`${API}/profiles?latest=1`, {
    authFetch, initialData: [], transform: (b) => latestProfiles(asList(b, 'profiles')),
  });
  if (loading) return <p className="text-sm text-gray-600 dark:text-gray-400">Loading import profiles…</p>;
  if (error?.message === 'HTTP 501' || (!error && profiles.length === 0)) return <Notice>{NO_PROFILES}</Notice>;
  if (error) return <Notice variant="warning">Could not load the import profiles: {error.message}</Notice>;
  const pick = (id) => {
    const p = profiles.find(x => String(x.id) === id);
    update(d => (p ? selectProfile(d, p) : { ...emptyDraft(), mode: 'repeat', runMode: d.runMode }));
  };
  return (
    <SelectField label="Import profile" value={draft.profile ? String(draft.profile.id) : ''} onChange={pick}>
      <option value="">Choose a profile…</option>
      {profiles.map(p => <option key={p.id} value={String(p.id)}>{p.name} (version {p.version})</option>)}
    </SelectField>
  );
}

export default function StepStart({ draft, update, onNext }) {
  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">What do you want to do?</legend>
        <OptionList options={MODE_OPTIONS} name="importMode" selected={draft.mode} onSelect={(m) => update(d => setMode(d, m))} />
      </fieldset>

      {draft.mode === 'repeat' && <ProfilePicker draft={draft} update={update} />}

      <fieldset>
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Run mode</legend>
        <OptionList options={RUN_MODE_OPTIONS} name="runMode" selected={draft.runMode} onSelect={(m) => update(d => ({ ...d, runMode: m }))} />
      </fieldset>

      {draft.mode === 'repeat' && (
        <label className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
          <input type="checkbox" checked={draft.adjust} onChange={e => update(d => ({ ...d, adjust: e.target.checked }))} />
          Adjust the configuration (entities, attributes and relations)
        </label>
      )}

      <WizardNav onNext={onNext} nextDisabled={!stepReady(1, draft)} />
    </div>
  );
}
