import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useCanBuildContexts } from '@ui/hooks/useCanBuildContexts';
import { Modal, ErrorBox } from './ModalPrimitives';
import Stepper from '@ui/components/Stepper';
import WizardBody from './NewContextWizardBody';
import WizardFooter from './NewContextWizardFooter';
import UploadListFlow from './upload/UploadListFlow';
import { useWizardData } from './useWizardData';
import {
  stepsFor, groupByTargetType, seedParamsFromSchema, settingsPending,
  pluginMissingParams, computeRefreshTargets, configStepReady, wizardTitles, firstStepOf,
} from './NewContextWizard.helpers';

// ─── Unified "New context tree" wizard ────────────────────────────────────────
// One stepped flow (matching the matrix / crawler wizards via the shared
// Stepper) for every way of creating a context tree:
//
//   Step 1  Source        — Import from a system (→ Crawlers) · Derive from data · Create by hand · Upload a list
//   Plugin: Step 2 Pick plugin → Step 3 Configure → Step 4 Preview & run
//   Org tree (manager chain): Step 2 Pick → 3 People → 4 Managers → 5 Names → 6 Preview & run
//   Manual: Step 2 Details (then Create)
//   Upload: Step 2 File → Step 3 Mapping → Step 4 Preview & import (upload/UploadListFlow,
//           which renders its own footer; `reimportListId` opens it on step 2 for that list)
//   Existing tree: `editTreeKey` opens the rule's settings on that tree's stored values
//
// The step bodies live in NewContextWizardBody, the footer in
// NewContextWizardFooter, and pure data shaping in NewContextWizard.helpers.

export default function NewContextWizard({ open, onClose, onCreated, onRunStarted, onOpenCrawlers, onOpenBuilder, reimportListId = null, editTreeKey = null }) {
  const { authFetch } = useAuth();
  const editing = !!editTreeKey;
  const firstStep = firstStepOf(editing);
  const canDescribe = useCanBuildContexts() && !!onOpenBuilder;

  const reimporting = open && !!reimportListId;
  const [step, setStep] = useState(reimporting ? 2 : 1);
  const [source, setSource] = useState(reimporting ? 'upload' : null); // 'import' | 'plugin' | 'manual' | 'upload' | 'describe'

  // Plugin path state
  const [selected, setSelected] = useState(null);
  const [params, setParams] = useState({});
  const [dryRunning, setDryRunning] = useState(false);
  const [dryResult, setDryResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  // Target: a brand-new tree, or refresh an existing one (keeps analyst edits).
  const [mode, setMode] = useState('new');         // 'new' | 'refresh'
  const [refreshKey, setRefreshKey] = useState(''); // sourceInstanceKey to refresh

  // Manual path state
  const [mTargetType, setMTargetType] = useState('Identity');
  // A new tree has no parent to inherit a template from, so it starts as a
  // Segment — the template that carries no roles and claims the least.
  const [mContextCategory, setMContextCategory] = useState('Segment');
  const [mContextType, setMContextType] = useState('');
  const [mDisplayName, setMDisplayName] = useState('');
  const [mDescription, setMDescription] = useState('');
  const [mScopeSystemId, setMScopeSystemId] = useState('');
  const [creating, setCreating] = useState(false);


  // Reset everything when the wizard closes — during render on the open→closed
  // transition, so no synchronous setState lives in an effect.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) resetAll();
    else if (reimportListId) { setSource('upload'); setStep(2); }
  }
  function resetAll() {
    setStep(1); setSource(null);
    setSelected(null); setParams({}); setDryResult(null);
    setError(null); setRunning(false); setDryRunning(false);
    setMTargetType('Identity'); setMContextCategory('Segment'); setMContextType(''); setMDisplayName('');
    setMDescription(''); setMScopeSystemId(''); setCreating(false);
    setMode('new'); setRefreshKey('');
  }

  // When a plugin is (re)selected: default back to creating a new tree and seed
  // its params with the schema defaults. Done during render on the selected
  // change (prev-value tracking) rather than in effects.
  const [seenSelected, setSeenSelected] = useState(selected);
  if (selected !== seenSelected) {
    setSeenSelected(selected);
    setMode('new'); setRefreshKey('');
    setParams(selected ? seedParamsFromSchema(selected) : {});
    setDryResult(null);
  }

  // Load the rules, systems and attributes when the wizard opens; on an
  // existing tree also its settings, marked as seen so they are not reseeded.
  const { systems, plugins, principalAttrs, genRoots, loading, loadError } = useWizardData({
    open, authFetch, editTreeKey,
    onTreeSettings: (tree) => {
      setSeenSelected(tree.plugin); setSelected(tree.plugin);
      setParams(tree.params); setMode('refresh'); setRefreshKey(tree.instanceKey);
      setSource('plugin'); setStep(3);
    },
  });

  const grouped = useMemo(() => groupByTargetType(plugins), [plugins]);
  const pluginMissing = useMemo(() => pluginMissingParams(selected, params), [selected, params]);
  const refreshTargets = useMemo(
    () => computeRefreshTargets(genRoots, selected, params.scopeSystemId),
    [genRoots, selected, params.scopeSystemId],
  );
  const manualValid = !!mDisplayName.trim() && !!mContextType.trim();
  const steps = stepsFor(source, selected);
  const previewStep = steps.length;

  // A changed setting makes the preview and the people count out of date.
  function updateParams(next) { setParams(next); setDryResult(null); }

  // Auto-preview when arriving at the plugin's final step.
  useEffect(() => {
    if (source === 'plugin' && step === previewStep && selected && !dryResult && !dryRunning) {
      dryRun();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, source, selected, previewStep]);

  if (!open) return null;

  function canNext() {
    if (step === 1) return !!source;
    if (source === 'plugin') {
      if (step === 2) return !!selected;
      if (step < previewStep) return configStepReady(pluginMissing, params);
    }
    return true;
  }

  function next() {
    if (step === 1 && source === 'import') { onOpenCrawlers?.(); onClose(); return; }
    if (step === 1 && source === 'describe') { onOpenBuilder?.(); onClose(); return; }
    setStep(s => s + 1);
  }
  function back() {
    // Stepping back to the Source step clears the chosen path so the Stepper
    // and content stay in sync.
    if (step === 2) { setStep(1); return; }
    setStep(s => Math.max(1, s - 1));
  }

  async function dryRun() {
    if (!selected) return;
    setDryRunning(true); setError(null); setDryResult(null);
    try {
      const r = await authFetch(`/api/context-plugins/${selected.name}/dry-run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setDryResult(body);
    } catch (err) {
      setError(err.message || 'Dry-run failed');
    } finally {
      setDryRunning(false);
    }
  }

  async function run() {
    if (!selected) return;
    setRunning(true); setError(null);
    try {
      // New tree → no instanceKey (the runner mints a fresh one). Refresh →
      // send the chosen tree's key so the runner reconciles onto it.
      const body = { ...params };
      if (mode === 'refresh' && refreshKey) body.instanceKey = refreshKey;
      const r = await authFetch(`/api/context-plugins/${selected.name}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(payload.error || `HTTP ${r.status}`);
      onRunStarted?.(payload.runId);
      onClose();
    } catch (err) {
      setError(err.message || 'Run failed');
      setRunning(false);
    }
  }

  async function createManual() {
    setCreating(true); setError(null);
    try {
      const r = await authFetch('/api/contexts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType: mTargetType,
          contextCategory: mContextCategory,
          contextType: mContextType.trim(),
          displayName: mDisplayName.trim(),
          description: mDescription.trim() || null,
          scopeSystemId: mScopeSystemId ? parseInt(mScopeSystemId, 10) : null,
        }),
      });
      const created = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(created.error || `HTTP ${r.status}`);
      onCreated?.(created);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to create context');
      setCreating(false);
    }
  }

  return (
    // On an existing tree, nothing to show until its settings are in.
    <SettingsGate pending={settingsPending(editTreeKey, selected)} loading={loading} loadError={loadError} onClose={onClose}>
    <Modal {...wizardTitles(editing, source, selected)} onClose={onClose} width={640} dismissOnBackdrop={false}>
      <div className="mb-4 border-b border-gray-100 dark:border-gray-700 pb-3">
        <Stepper steps={steps} current={step} onStepClick={(n) => n < step && n >= firstStep && setStep(n)} />
      </div>

      <ErrorBox message={loadError} />

      {source === 'upload' && step >= 2 ? (
        <UploadListFlow
          step={step} onStep={setStep} onBackToSource={() => setStep(1)} reimportListId={reimportListId}
          onImported={(result) => { onCreated?.({ id: result.rootContextId }); onClose(); }}
        />
      ) : (
        <>
          {/* ─── Step content ─── */}
          <WizardBody
            source={source} step={step} loading={loading}
            setSource={setSource} canDescribe={canDescribe}
            grouped={grouped} selected={selected} setSelected={setSelected}
            params={params} setParams={updateParams} systems={systems} principalAttrs={principalAttrs}
            previewStep={previewStep} editing={editing}
            mode={mode} setMode={setMode} refreshKey={refreshKey} setRefreshKey={setRefreshKey}
            refreshTargets={refreshTargets}
            dryRunning={dryRunning} dryResult={dryResult} onDryRun={dryRun}
            mTargetType={mTargetType} setMTargetType={setMTargetType}
            mContextCategory={mContextCategory} setMContextCategory={setMContextCategory}
            mContextType={mContextType} setMContextType={setMContextType}
            mDisplayName={mDisplayName} setMDisplayName={setMDisplayName}
            mDescription={mDescription} setMDescription={setMDescription}
            mScopeSystemId={mScopeSystemId} setMScopeSystemId={setMScopeSystemId}
          />

          <ErrorBox message={error} />

          {/* ─── Footer ─── */}
          <WizardFooter
            source={source} step={step} previewStep={previewStep} pluginMissing={pluginMissing}
            showBack={step > firstStep} onBack={back}
            editing={editing} previewCount={dryResult?.contextCount}
            running={running} dryRunning={dryRunning} mode={mode} refreshKey={refreshKey}
            manualValid={manualValid} creating={creating} canNext={canNext()}
            onRun={run} onCreate={createManual} onNext={next}
          />
        </>
      )}
    </Modal>
    </SettingsGate>
  );
}

// The wizard opened on an existing tree, while that tree's settings load (or failed to).
function SettingsGate({ pending, loading, loadError, onClose, children }) {
  if (!pending) return children;
  return (
    <Modal {...wizardTitles(true)} onClose={onClose} width={640} dismissOnBackdrop={false}>
      <ErrorBox message={loadError} />
      {loading && <p className="text-xs text-gray-500 dark:text-gray-400">Loading the settings of this tree…</p>}
    </Modal>
  );
}
