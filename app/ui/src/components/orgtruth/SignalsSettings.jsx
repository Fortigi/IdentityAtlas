// Organisation → Signals → the settings of one collection type: after how many
// months without activity it counts as inactive, and which attribute (with
// which values) marks it inactive in the list itself.
//
// GET /api/org-truth/signals/settings → { [type]: { inactiveAfterMonths,
// statusAttribute, inactiveValues } }; Save PUTs the whole map with this type's
// entry replaced (settingsBody, signals.js). Saving needs the same right as a
// profile edit (useCanImportOrgTruth); readers see the values read-only.
//
// Props: { type, model, onSaved }
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useCanImportOrgTruth } from '@ui/hooks/useCanImportOrgTruth';
import { useDialog } from '@ui/components/dialogContext';
import { fetchBlocked, readErrorDetail } from './orgFormat';
import { SETTINGS_URL, settingsDraft, settingsError, settingsBody, statusAttributeOptions, MAX_MONTHS } from './signals';
import { FetchState, InlineError, CARD, INPUT, SMALL_BUTTON } from './orgUi';

const LABEL = 'flex flex-col gap-1 text-xs font-medium text-gray-700 dark:text-gray-300';

function SettingsForm({ type, model, all, canEdit, onSaved }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const [draft, setDraft] = useState(() => settingsDraft(all?.[type]));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (field) => (e) => setDraft(d => ({ ...d, [field]: e.target.value }));
  const options = statusAttributeOptions(model, type, draft.statusAttribute);

  async function save() {
    const invalid = settingsError(draft);
    if (invalid) { setError(invalid); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch(SETTINGS_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsBody(all, type, draft)),
      });
      if (!res.ok) { setError(`The settings were not saved: ${(await readErrorDetail(res)) || `HTTP ${res.status}`}`); return; }
      dialog.toast(`Signal settings for ${type} saved`, { variant: 'success' });
      onSaved?.();
    } catch (err) {
      setError(`The settings were not saved: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <InlineError message={error} />
      <div className="flex flex-wrap items-end gap-4">
        <label className={LABEL}>
          Inactive after (months)
          <input type="number" min={1} max={MAX_MONTHS} className={`${INPUT} w-24`} value={draft.months}
            disabled={!canEdit} onChange={set('months')} />
        </label>
        <label className={LABEL}>
          Status attribute
          <select className={INPUT} value={draft.statusAttribute} disabled={!canEdit} onChange={set('statusAttribute')}>
            <option value="">None</option>
            {options.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <label className={LABEL}>
          Values that mean inactive
          <input type="text" className={`${INPUT} w-56`} value={draft.inactiveValues} placeholder="e.g. true, closed"
            disabled={!canEdit || !draft.statusAttribute} onChange={set('inactiveValues')} />
        </label>
        {canEdit && <button type="button" className={SMALL_BUTTON} disabled={busy} onClick={save}>Save settings</button>}
      </div>
      {!canEdit && <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">Changing these settings needs permission to import additional information.</p>}
    </>
  );
}

export default function SignalsSettings({ type, model, onSaved }) {
  const { authFetch } = useAuth();
  const canEdit = useCanImportOrgTruth();
  const state = useFetch(SETTINGS_URL, { authFetch });
  return (
    <section aria-label={`Signal settings for ${type}`} className={`${CARD} p-3`}>
      <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">Settings</h3>
      {fetchBlocked(state)
        ? <FetchState state={state} what="Settings" />
        : <SettingsForm type={type} model={model} all={state.data} canEdit={canEdit} onSaved={() => { state.reload(); onSaved?.(); }} />}
    </section>
  );
}
