// Organisation → Model → Link rules: correct the links after the fact.
//
// One card per import profile (newest version, from GET /model `profiles`).
// Each card draws its rules on a canvas (RuleCanvas: entity boxes on top,
// system boxes below, a line per rule from attribute row to field row) with a
// plain list of the same rules under it. Click an attribute row, then a field
// row in another box, to draw a new relation; click a line to edit or remove
// it (RulePopover). Edits stay local — the card shows "Unsaved changes" — until
// "Save and link again" POSTs the whole list to /profiles/:id/relink; the run
// it starts is polled (useImportRun.track) and the model reloads when it ends.
// The pencil on an entity box renames that entity type (POST rename-type).
// Readers (no useCanImportOrgTruth) see the canvas and list without controls.
//
// Props: { model, onRelinked }   — onRelinked reloads the model (useFetch reload)
import { useMemo, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useDialog } from '@ui/components/dialogContext';
import { useCanImportOrgTruth } from '@ui/hooks/useCanImportOrgTruth';
import { useImportRun } from './wizard/useImportRun';
import {
  addRule, replaceRule, removeRuleAt, newRule, rowAction, ruleLabel, signalsSummary,
  relinkProfile, renameEntityType, canRename,
} from './linkRulesDraft';
import { layoutCanvas, canvasLines } from './modelCanvas';
import RuleCanvas from './RuleCanvas';
import RulePopover from './RulePopover';
import { CARD, SMALL_BUTTON, StatusPill } from './orgUi';

const SAVE_CLS = 'px-3 py-1.5 text-sm rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-green-700 dark:hover:bg-green-600';

function RunProgress({ run }) {
  if (!run) return null;
  const links = run.stats?.links ?? {};
  let text = `Linking again… ${run.step ?? run.status ?? 'queued'}${run.pct != null ? ` (${run.pct}%)` : ''}`;
  if (run.status === 'completed') text = `Linked again${links.linked != null ? `: ${links.linked} linked, ${links.proposed ?? 0} proposed for review` : ''}.`;
  if (run.status === 'failed') text = `Linking again failed: ${run.error ?? 'unknown error'}`;
  return <p role="status" aria-live="polite" className="text-sm text-gray-700 dark:text-gray-300">{text}</p>;
}

function SaveErrors({ error }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300">
      <p>{error.message}</p>
      {error.list.length > 0 && <ul className="mt-1 list-disc pl-5">{error.list.map(e => <li key={e}>{e}</li>)}</ul>}
    </div>
  );
}

function RuleList({ name, rules, canEdit, onEdit, onRemove }) {
  if (rules.length === 0) return <p className="text-sm text-gray-600 dark:text-gray-400">No link rules yet.</p>;
  return (
    <ul aria-label={`Link rules of ${name}`} className="divide-y divide-gray-100 dark:divide-gray-700 text-sm">
      {rules.map((r, i) => {
        const label = ruleLabel(r);
        return (
          <li key={`${label}:${i}`} className="flex flex-wrap items-center gap-3 py-1.5 text-gray-700 dark:text-gray-300">
            <span className="font-medium text-gray-900 dark:text-gray-100">{label}</span>
            <span>{signalsSummary(r.signals)}</span>
            <span>threshold {r.threshold ?? 50}</span>
            {canEdit && (
              <span className="ml-auto flex gap-2">
                <button type="button" className={SMALL_BUTTON} aria-label={`Edit ${label}`} onClick={() => onEdit(i)}>Edit</button>
                <button type="button" className={SMALL_BUTTON} aria-label={`Remove ${label}`} onClick={() => onRemove(i)}>Remove</button>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// The rename flow of one card: start (asks first when rule edits are unsaved),
// type, Enter saves, Escape cancels.
function useRename({ profile, dirty, discard, onRelinked, setError }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const [rename, setRename] = useState(null);

  const start = async (type) => {
    if (dirty) {
      const ok = await dialog.confirm({
        title: 'Unsaved link rules',
        message: 'Renaming saves a new version of this profile. Discard your unsaved rule changes and rename, or keep editing and save them first.',
        confirmLabel: 'Discard and rename',
        cancelLabel: 'Keep editing',
        danger: true,
      });
      if (!ok) return;
      discard();
    }
    setRename({ type, value: type });
  };
  const save = async () => {
    if (!canRename(rename.type, rename.value)) { setRename(null); return; }
    const res = await renameEntityType(authFetch, profile.id, rename.type, rename.value);
    if (!res.ok) { setError({ message: res.error, list: [] }); return; }
    dialog.toast(`Renamed ${rename.type} to ${rename.value.trim()}`, { variant: 'success' });
    setRename(null);
    onRelinked();
  };
  return {
    rename, start, save,
    change: (value) => setRename(r => ({ ...r, value })),
    cancel: () => setRename(null),
  };
}

function ProfileCard({ profile, model, canEdit, onRelinked }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const { run, busy, track } = useImportRun();
  const [draft, setDraft] = useState(null);
  const [selection, setSelection] = useState(null);
  const [editor, setEditor] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const rules = useMemo(() => draft ?? profile.linkRules ?? [], [draft, profile.linkRules]);
  const dirty = draft !== null;
  const editable = canEdit && !busy && !saving;
  const renamer = useRename({ profile, dirty, discard: () => setDraft(null), onRelinked, setError });

  const layout = useMemo(() => layoutCanvas(profile, model), [profile, model]);
  const lines = useMemo(() => canvasLines(layout, rules, model), [layout, rules, model]);

  const onRow = (row) => {
    const act = rowAction(selection, row, editable);
    if (act.type === 'select') setSelection(act.source);
    if (act.type === 'clear') setSelection(null);
    if (act.type === 'open') {
      setSelection(null);
      setEditor({ index: -1, rule: newRule(act.source, act.target), error: null });
    }
  };
  const openEdit = (index) => { if (editable) setEditor({ index, rule: rules[index], error: null }); };
  const submit = () => {
    const res = editor.index < 0 ? addRule(rules, editor.rule) : replaceRule(rules, editor.index, editor.rule);
    if (res.error) { setEditor({ ...editor, error: res.error }); return; }
    setDraft(res.rules);
    setEditor(null);
  };
  const remove = async (index) => {
    const ok = await dialog.confirm({
      message: `Remove the link rule ${ruleLabel(rules[index])}? Its links are rejected when you save and link again.`,
      confirmLabel: 'Remove', cancelLabel: 'Keep it', danger: true,
    });
    if (!ok) return;
    setDraft(removeRuleAt(rules, index));
    setEditor(null);
  };
  const save = async () => {
    setError(null);
    setSaving(true);
    const res = await relinkProfile(authFetch, profile.id, rules);
    setSaving(false);
    if (!res.ok) { setError({ message: res.error, list: res.errors }); return; }
    track(res.run, () => { setDraft(null); onRelinked(); });
  };

  return (
    <div className={`${CARD} p-3 space-y-3`} data-profile={profile.name}>
      <div className="flex flex-wrap items-center gap-3">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{profile.name}</h4>
        <span className="text-xs text-gray-600 dark:text-gray-400">version {profile.version}</span>
        <StatusPill status={profile.lastRunStatus} />
        {dirty && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">Unsaved changes</span>}
        {canEdit && (
          <button type="button" className={`${SAVE_CLS} ml-auto`} disabled={!dirty || busy || saving} onClick={save}>
            Save and link again
          </button>
        )}
      </div>
      {canEdit && (
        <p className="text-xs text-gray-600 dark:text-gray-400">
          Click an attribute, then a field in another box, to link them. Click a line to change or remove it.
        </p>
      )}
      <SaveErrors error={error} />
      <RunProgress run={run} />
      <RuleCanvas
        layout={layout} lines={lines} selection={selection} canEdit={editable}
        onRow={onRow} onLine={openEdit}
        rename={renamer.rename} onRenameStart={renamer.start} onRenameChange={renamer.change}
        onRenameSave={renamer.save} onRenameCancel={renamer.cancel}
      />
      {editor && (
        <RulePopover
          mode={editor.index < 0 ? 'new' : 'edit'} rule={editor.rule} error={editor.error}
          onChange={rule => setEditor({ ...editor, rule, error: null })}
          onSubmit={submit} onRemove={() => remove(editor.index)} onCancel={() => setEditor(null)}
        />
      )}
      <RuleList name={profile.name} rules={rules} canEdit={editable} onEdit={openEdit} onRemove={remove} />
    </div>
  );
}

export default function LinkRulesEditor({ model, onRelinked }) {
  const canEdit = useCanImportOrgTruth();
  const profiles = model?.profiles ?? [];
  if (profiles.length === 0) return null;
  return (
    <section aria-labelledby="ot-link-rules" className="space-y-3">
      <h3 id="ot-link-rules" className="text-base font-semibold text-gray-900 dark:text-gray-100">Link rules</h3>
      {profiles.map(p => <ProfileCard key={p.name} profile={p} model={model} canEdit={canEdit} onRelinked={onRelinked} />)}
    </section>
  );
}
