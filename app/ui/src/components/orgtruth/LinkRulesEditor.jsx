// Organisation → Model → the model canvas: ONE canvas for the whole model.
//
// Every entity type of every import profile (newest version, from GET /model
// `profiles`) is a card with its list as a chip, next to the system cards
// (Account, Person, Group/resource, Context); every link rule of every profile
// is a line from attribute row to field row, and the organisation relations
// are dashed lines between cards (modelCanvas.js). Cards are dragged by their
// header (or moved with the arrow keys), the canvas pans and zooms
// (useCanvasGestures), and the layout is shared through the API
// (useCanvasLayout); "Reset layout" goes back to the automatic one
// (canvasLayout.js). "Highlight list" fades the other lists.
//
// Editing works as it did per list: drag from an attribute row to a field row
// (or click the attribute, then the field) to draw a relation, click a line to
// change or remove it (RulePopover), the pencil renames an entity type. Each
// edit lands in the draft of the profile that OWNS the entity type, and each
// profile saves on its own (ProfileRules: "Save and link again" POSTs that
// profile's whole list to /profiles/:id/relink; rename-type goes to the owning
// profile too). Readers see the canvas and the lists without controls.
//
// Props: { model, onRelinked }   — onRelinked reloads the model (useFetch reload)
import { useMemo, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useDialog } from '@ui/components/dialogContext';
import { useCanImportOrgTruth } from '@ui/hooks/useCanImportOrgTruth';
import Select from '@ui/components/inputs/Select';
import {
  addRule, replaceRule, removeRuleAt, newRule, rowAction, ruleLabel, renameEntityType, canRename,
} from './linkRulesDraft';
import { canvasBoxes, ruleEntries, placeBoxes, canvasLines, predicateLines } from './modelCanvas';
import { autoLayout, mergePositions, canvasBounds } from './canvasLayout';
import { useCanvasLayout } from './useCanvasLayout';
import { useCanvasGestures } from './useCanvasGestures';
import RuleCanvas from './RuleCanvas';
import RulePopover from './RulePopover';
import ProfileRules, { SaveErrors } from './ProfileRules';
import { CARD, INPUT, SMALL_BUTTON } from './orgUi';

const ZOOM_STEP = 1.2;

// The profile that owns an entity type's card (where its rules live).
const ownerOf = (profiles, boxes, entityType) => {
  const box = boxes.find(b => b.kind === 'entity' && b.entityType === entityType);
  return profiles.find(p => p.name === box?.owner) ?? null;
};

// The rename flow: start (asks first when the owning profile has unsaved rule
// edits), type, Enter saves to the owning profile, Escape cancels.
function useRename({ owner, drafts, discard, onRelinked, setError }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const [rename, setRename] = useState(null);

  const start = async (type) => {
    const profile = owner(type);
    if (!profile) return;
    if (drafts[profile.name]) {
      const ok = await dialog.confirm({
        title: 'Unsaved link rules',
        message: `Renaming saves a new version of ${profile.name}. Discard your unsaved rule changes to that list and rename, or keep editing and save them first.`,
        confirmLabel: 'Discard and rename',
        cancelLabel: 'Keep editing',
        danger: true,
      });
      if (!ok) return;
      discard(profile.name);
    }
    setRename({ type, value: type, profile });
  };
  const save = async () => {
    if (!canRename(rename.type, rename.value)) { setRename(null); return; }
    const res = await renameEntityType(authFetch, rename.profile.id, rename.type, rename.value);
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

// The rule drafts of every profile ({ [profileName]: rules }) and the popover
// that edits one rule of one of them.
function useRuleEdits(profiles) {
  const dialog = useDialog();
  const [drafts, setDrafts] = useState({});
  const [editor, setEditor] = useState(null);
  const rulesOf = (name) => drafts[name] ?? profiles.find(p => p.name === name)?.linkRules ?? [];
  const setRules = (name, rules) => setDrafts(d => ({ ...d, [name]: rules }));
  const discard = (name) => setDrafts(({ [name]: _gone, ...rest }) => rest);

  const openNew = (profile, source, target) => setEditor({ profile, index: -1, rule: newRule(source, target), error: null });
  const openEdit = (profile, index) => setEditor({ profile, index, rule: rulesOf(profile)[index], error: null });
  const submit = () => {
    const rules = rulesOf(editor.profile);
    const res = editor.index < 0 ? addRule(rules, editor.rule) : replaceRule(rules, editor.index, editor.rule);
    if (res.error) { setEditor({ ...editor, error: res.error }); return; }
    setRules(editor.profile, res.rules);
    setEditor(null);
  };
  const remove = async (profile, index) => {
    const ok = await dialog.confirm({
      message: `Remove the link rule ${ruleLabel(rulesOf(profile)[index])}? Its links are rejected when you save and link again.`,
      confirmLabel: 'Remove', cancelLabel: 'Keep it', danger: true,
    });
    if (!ok) return;
    setRules(profile, removeRuleAt(rulesOf(profile), index));
    setEditor(null);
  };
  return { drafts, editor, setEditor, rulesOf, discard, openNew, openEdit, submit, remove };
}

function Toolbar({ profiles, highlight, onHighlight, onZoom, onFit, onReset }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        Highlight list
        <Select aria-label="Highlight list" className={INPUT} value={highlight} onChange={e => onHighlight(e.target.value)}>
          <option value="">All lists</option>
          {profiles.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
        </Select>
      </label>
      <span className="ml-auto flex gap-2">
        <button type="button" className={SMALL_BUTTON} aria-label="Zoom in" onClick={() => onZoom(ZOOM_STEP)}>+</button>
        <button type="button" className={SMALL_BUTTON} aria-label="Zoom out" onClick={() => onZoom(1 / ZOOM_STEP)}>−</button>
        <button type="button" className={SMALL_BUTTON} onClick={onFit}>Fit</button>
        <button type="button" className={SMALL_BUTTON} onClick={onReset}>Reset layout</button>
      </span>
    </div>
  );
}

export default function LinkRulesEditor({ model, onRelinked }) {
  const canEdit = useCanImportOrgTruth();
  const profiles = useMemo(() => model?.profiles ?? [], [model]);
  const edits = useRuleEdits(profiles);
  const layout = useCanvasLayout(canEdit);
  const [selection, setSelection] = useState(null);
  const [highlight, setHighlight] = useState('');
  const [busy, setBusy] = useState({});
  const [error, setError] = useState(null);
  const editable = canEdit && !Object.values(busy).some(Boolean);

  const boxes = useMemo(() => canvasBoxes(model), [model]);
  const auto = useMemo(() => autoLayout(boxes), [boxes]);
  const positions = useMemo(() => mergePositions(boxes, auto, layout.saved), [boxes, auto, layout.saved]);
  const placed = useMemo(() => placeBoxes(boxes, positions), [boxes, positions]);
  const entries = useMemo(() => ruleEntries(profiles, edits.drafts), [profiles, edits.drafts]);
  const lines = useMemo(() => canvasLines(placed, entries, model), [placed, entries, model]);
  const predicates = useMemo(() => predicateLines(placed, model), [placed, model]);
  const owner = (type) => ownerOf(profiles, boxes, type);
  const renamer = useRename({ owner, drafts: edits.drafts, discard: edits.discard, onRelinked, setError });

  const connect = (source, row) => {
    const act = rowAction({ entityType: source.entityType, attribute: source.attribute }, row, editable);
    const profile = owner(act.source?.entityType);
    if (act.type !== 'open' || !profile) return;
    setSelection(null);
    edits.openNew(profile.name, act.source, act.target);
  };
  const onRow = (row) => {
    const act = rowAction(selection, row, editable);
    if (act.type === 'select') setSelection(act.source);
    if (act.type === 'clear') setSelection(null);
    if (act.type === 'open') connect(act.source, row);
  };
  const gestures = useCanvasGestures({
    placed, positions, canConnect: editable,
    onMove: (id, pos) => layout.move(positions, id, pos),
    onMoveEnd: layout.commit,
    onConnect: connect,
  });
  const nudge = (id, dx, dy) => {
    layout.move(positions, id, { x: positions[id].x + dx, y: positions[id].y + dy });
    layout.commit();
  };

  if (profiles.length === 0 && boxes.every(b => b.kind === 'system')) return null;
  return (
    <section aria-labelledby="ot-model-canvas" className={`${CARD} p-3 space-y-3`}>
      <h3 id="ot-model-canvas" className="text-base font-semibold text-gray-900 dark:text-gray-100">Model canvas</h3>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        Drag a card by its header to move it; drag the background to pan, scroll to zoom.
        {canEdit && ' Drag from an attribute to a field (or click one, then the other) to link them; click a line to change or remove it.'}
      </p>
      <Toolbar profiles={profiles} highlight={highlight} onHighlight={setHighlight}
        onZoom={gestures.zoomBy} onFit={() => gestures.fit(canvasBounds(placed))} onReset={layout.reset} />
      <SaveErrors error={error} />
      {layout.ready && (
        <RuleCanvas
          placed={placed} lines={lines} predicates={predicates} ghost={gestures.ghost} view={gestures.view}
          svgRef={gestures.svgRef} handlers={gestures.handlers}
          selection={selection} canEdit={editable} highlight={highlight}
          onRow={onRow} onLine={l => editable && edits.openEdit(l.profile, l.index)} onNudge={nudge}
          rename={renamer.rename} onRenameStart={renamer.start} onRenameChange={renamer.change}
          onRenameSave={renamer.save} onRenameCancel={renamer.cancel}
        />
      )}
      {edits.editor && (
        <RulePopover
          mode={edits.editor.index < 0 ? 'new' : 'edit'} rule={edits.editor.rule} error={edits.editor.error}
          onChange={rule => edits.setEditor({ ...edits.editor, rule, error: null })}
          onSubmit={edits.submit} onRemove={() => edits.remove(edits.editor.profile, edits.editor.index)}
          onCancel={() => edits.setEditor(null)}
        />
      )}
      <div className="divide-y divide-gray-100 dark:divide-gray-700">
        {profiles.map(p => (
          <ProfileRules
            key={p.name} profile={p} rules={edits.rulesOf(p.name)} dirty={Boolean(edits.drafts[p.name])} canEdit={canEdit}
            onEdit={i => edits.openEdit(p.name, i)} onRemove={i => edits.remove(p.name, i)}
            onBusy={b => setBusy(s => ({ ...s, [p.name]: b }))}
            onSaved={() => { edits.discard(p.name); onRelinked(); }}
          />
        ))}
      </div>
    </section>
  );
}
