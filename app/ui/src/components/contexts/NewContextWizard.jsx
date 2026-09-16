import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { Modal, ErrorBox } from './ModalPrimitives';
import Stepper from '@ui/components/Stepper';
import WizardBody from './NewContextWizardBody';
import WizardFooter from './NewContextWizardFooter';
import {
  stepsFor, groupByTargetType, wizardSubtitle, seedParamsFromSchema,
  pluginMissingParams, computeRefreshTargets,
} from './NewContextWizard.helpers';

// ─── Unified "New context tree" wizard ────────────────────────────────────────
// One stepped flow (matching the matrix / crawler wizards via the shared
// Stepper) for every way of creating a context tree:
//
//   Step 1  Source        — Import (→ Crawlers) · Run a plugin · Create manual
//   Plugin: Step 2 Pick plugin → Step 3 Configure → Step 4 Preview & run
//   Manual: Step 2 Details (then Create)
//
// The step bodies live in NewContextWizardBody, the footer in
// NewContextWizardFooter, and pure data shaping in NewContextWizard.helpers.

export default function NewContextWizard({ open, onClose, onCreated, onRunStarted, onOpenCrawlers }) {
  const { authFetch } = useAuth();

  const [step, setStep] = useState(1);
  const [source, setSource] = useState(null); // 'import' | 'plugin' | 'manual'

  // Shared / plugin data
  const [systems, setSystems] = useState([]);
  const [plugins, setPlugins] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [principalAttrs, setPrincipalAttrs] = useState({ columns: [], extended: [] });

  // Plugin path state
  const [selected, setSelected] = useState(null);
  const [params, setParams] = useState({});
  const [dryRunning, setDryRunning] = useState(false);
  const [dryResult, setDryResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  // Target: a brand-new tree, or refresh an existing one (keeps analyst edits).
  const [genRoots, setGenRoots] = useState([]);   // existing generated root contexts
  const [mode, setMode] = useState('new');         // 'new' | 'refresh'
  const [refreshKey, setRefreshKey] = useState(''); // sourceInstanceKey to refresh

  // Manual path state
  const [mTargetType, setMTargetType] = useState('Identity');
  const [mContextType, setMContextType] = useState('');
  const [mDisplayName, setMDisplayName] = useState('');
  const [mDescription, setMDescription] = useState('');
  const [mScopeSystemId, setMScopeSystemId] = useState('');
  const [creating, setCreating] = useState(false);

  // Load plugins + systems + principal attributes when the wizard opens.
  useEffect(() => {
    if (!open) return;
    (async () => {
      setLoading(true); setLoadError(null);
      try {
        const [pr, sr, cr, gr] = await Promise.all([
          authFetch('/api/context-plugins'),
          authFetch('/api/systems'),
          authFetch('/api/context-plugins/principal-attributes'),
          authFetch('/api/contexts?variant=generated'),
        ]);
        if (pr.ok) setPlugins((await pr.json()).data || []);
        if (sr.ok) { const b = await sr.json(); setSystems(b.data || b || []); }
        if (cr.ok) { const ab = await cr.json(); setPrincipalAttrs({ columns: ab.columns || [], extended: ab.extended || [] }); }
        if (gr.ok) { const g = await gr.json(); setGenRoots(g.data || []); }
      } catch (e) {
        setLoadError(e.message || 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [open, authFetch]);

  // Reset everything when the wizard closes — during render on the open→closed
  // transition, so no synchronous setState lives in an effect.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) resetAll();
  }
  function resetAll() {
    setStep(1); setSource(null);
    setSelected(null); setParams({}); setDryResult(null);
    setError(null); setRunning(false); setDryRunning(false);
    setMTargetType('Identity'); setMContextType(''); setMDisplayName('');
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

  const grouped = useMemo(() => groupByTargetType(plugins), [plugins]);
  const pluginMissing = useMemo(() => pluginMissingParams(selected, params), [selected, params]);
  const refreshTargets = useMemo(
    () => computeRefreshTargets(genRoots, selected, params.scopeSystemId),
    [genRoots, selected, params.scopeSystemId],
  );
  const manualValid = !!mDisplayName.trim() && !!mContextType.trim();

  // Auto-preview when arriving at the plugin's final step.
  useEffect(() => {
    if (source === 'plugin' && step === 4 && selected && !dryResult && !dryRunning) {
      dryRun();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, source, selected]);

  if (!open) return null;

  function canNext() {
    if (step === 1) return !!source;
    if (source === 'plugin') {
      if (step === 2) return !!selected;
      if (step === 3) return pluginMissing.length === 0;
    }
    return true;
  }

  function next() {
    if (step === 1 && source === 'import') { onOpenCrawlers?.(); onClose(); return; }
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

  const steps = stepsFor(source);

  return (
    <Modal title="New context tree" subtitle={wizardSubtitle(source, selected)} onClose={onClose} width={640} dismissOnBackdrop={false}>
      <div className="mb-4 border-b border-gray-100 dark:border-gray-700 pb-3">
        <Stepper steps={steps} current={step} onStepClick={(n) => n < step && setStep(n)} />
      </div>

      <ErrorBox message={loadError} />

      {/* ─── Step content ─── */}
      <WizardBody
        source={source} step={step} loading={loading}
        setSource={setSource}
        grouped={grouped} selected={selected} setSelected={setSelected}
        params={params} setParams={setParams} systems={systems} principalAttrs={principalAttrs}
        mode={mode} setMode={setMode} refreshKey={refreshKey} setRefreshKey={setRefreshKey}
        refreshTargets={refreshTargets}
        dryRunning={dryRunning} dryResult={dryResult} onDryRun={dryRun}
        mTargetType={mTargetType} setMTargetType={setMTargetType}
        mContextType={mContextType} setMContextType={setMContextType}
        mDisplayName={mDisplayName} setMDisplayName={setMDisplayName}
        mDescription={mDescription} setMDescription={setMDescription}
        mScopeSystemId={mScopeSystemId} setMScopeSystemId={setMScopeSystemId}
      />

      <ErrorBox message={error} />

      {/* ─── Footer ─── */}
      <WizardFooter
        source={source} step={step} pluginMissing={pluginMissing}
        showBack={step > 1} onBack={back}
        running={running} dryRunning={dryRunning} mode={mode} refreshKey={refreshKey}
        manualValid={manualValid} creating={creating} canNext={canNext()}
        onRun={run} onCreate={createManual} onNext={next}
      />
    </Modal>
  );
}
