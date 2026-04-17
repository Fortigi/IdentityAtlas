// Identity Atlas v5 — Account Correlation Ruleset wizard.
//
// Multi-step UX for creating account correlation rulesets via LLM. Steps:
//   1. Sources   — domain, org name, hints, connected systems
//   2. Generate  — POST /correlation-rulesets/generate, refine via chat
//   3. Save      — name + persist to GraphCorrelationRulesets

import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthGate';

const STEPS = [
  { key: 'sources',   label: 'Sources' },
  { key: 'generate',  label: 'Generate & Refine' },
  { key: 'save',      label: 'Save Ruleset' },
];

export default function CorrelationWizard({ onClose, onSaved }) {
  const { authFetch } = useAuth();
  const [stepIdx, setStepIdx] = useState(0);
  const [llmReady, setLlmReady] = useState(null);

  // Step 1: sources
  const [domain, setDomain] = useState('');
  const [orgName, setOrgName] = useState('');
  const [hints, setHints] = useState('');
  const [systems, setSystems] = useState([]);

  // Step 2: generation + chat
  const [generating, setGenerating] = useState(false);
  const [ruleset, setRuleset] = useState(null);
  const [transcript, setTranscript] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [refining, setRefining] = useState(false);
  const [llmModel, setLlmModel] = useState(null);
  const [genError, setGenError] = useState(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const isWorking = generating || refining;
  useEffect(() => {
    if (!isWorking) { setElapsedMs(0); return; }
    const start = Date.now();
    const interval = setInterval(() => setElapsedMs(Date.now() - start), 500);
    return () => clearInterval(interval);
  }, [isWorking]);
  const elapsedSec = Math.floor(elapsedMs / 1000);

  // Step 3: save
  const [rulesetName, setRulesetName] = useState('');
  const [savingRuleset, setSavingRuleset] = useState(false);
  const [savedRulesetId, setSavedRulesetId] = useState(null);

  // Check LLM at mount
  useEffect(() => {
    authFetch('/api/admin/llm/status')
      .then(r => r.ok ? r.json() : { configured: false })
      .then(j => setLlmReady(!!j.configured));
  }, [authFetch]);

  // Load connected systems for context
  useEffect(() => {
    authFetch('/api/systems')
      .then(r => r.ok ? r.json() : { data: [] })
      .then(j => setSystems((j.data || []).map(s => ({ id: s.id, name: s.systemName }))))
      .catch(() => setSystems([]));
  }, [authFetch]);

  if (llmReady === null) {
    return <Modal onClose={onClose} title="Account Correlation Wizard"><div className="p-6">Loading…</div></Modal>;
  }
  if (!llmReady) {
    return (
      <Modal onClose={onClose} title="Account Correlation Wizard">
        <div className="p-6">
          <div className="text-sm text-amber-700">
            No LLM provider is configured yet. Open <strong>Admin → LLM Settings</strong> to add credentials, then come back.
          </div>
        </div>
      </Modal>
    );
  }

  // ── Step actions ──

  async function handleGenerate() {
    setGenerating(true);
    setGenError(null);
    setRuleset(null);
    setTranscript([]);
    try {
      const r = await authFetch('/api/correlation-rulesets/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain,
          organizationName: orgName || undefined,
          hints: hints || undefined,
          systems: systems.length > 0 ? systems : undefined,
        }),
      });
      let j;
      try { j = await r.json(); } catch { j = null; }
      if (!r.ok || j?.error) {
        setGenError(j?.error || `HTTP ${r.status}`);
      } else {
        setRuleset(j.ruleset);
        setLlmModel(j.llmModel);
        setStepIdx(1); // move to refine step
      }
    } catch (err) {
      setGenError(err.message);
    } finally {
      setGenerating(false);
    }
  }

  async function handleRefine() {
    if (!chatInput.trim()) return;
    setRefining(true);
    const userMsg = chatInput.trim();
    setChatInput('');
    try {
      const r = await authFetch('/api/correlation-rulesets/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ruleset,
          transcript,
          userMessage: userMsg,
        }),
      });
      const j = await r.json();
      if (!r.ok || j.error) {
        setGenError(j.error || `HTTP ${r.status}`);
      } else {
        const newTranscript = [...transcript, { role: 'user', content: userMsg }, { role: 'assistant', content: j.assistantMessage }];
        setTranscript(newTranscript);
        if (j.rulesetChanged) {
          setRuleset(j.ruleset);
        }
      }
    } catch (err) {
      setGenError(err.message);
    } finally {
      setRefining(false);
    }
  }

  async function handleSave() {
    setSavingRuleset(true);
    try {
      const r = await authFetch('/api/correlation-rulesets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ruleset,
          version: rulesetName || '1.0',
        }),
      });
      const j = await r.json();
      if (!r.ok || j.error) {
        setGenError(j.error || `HTTP ${r.status}`);
      } else {
        setSavedRulesetId(j.id);
        onSaved?.();
      }
    } catch (err) {
      setGenError(err.message);
    } finally {
      setSavingRuleset(false);
    }
  }

  const currentStep = STEPS[stepIdx];

  return (
    <Modal onClose={onClose} title="Account Correlation Wizard">
      <div className="flex flex-col h-[80vh]">
        {/* Progress bar */}
        <div className="flex border-b border-gray-200 px-6 py-3 bg-gray-50">
          {STEPS.map((s, i) => {
            const done = i < stepIdx;
            const active = i === stepIdx;
            return (
              <div key={s.key} className="flex-1 flex items-center">
                <div className={`flex items-center gap-2 ${active ? 'font-semibold text-indigo-700' : done ? 'text-gray-700' : 'text-gray-400'}`}>
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${active ? 'bg-indigo-600 text-white' : done ? 'bg-green-500 text-white' : 'bg-gray-200'}`}>
                    {done ? '✓' : i + 1}
                  </div>
                  <span className="text-sm">{s.label}</span>
                </div>
                {i < STEPS.length - 1 && <div className={`flex-1 h-px ml-3 ${done ? 'bg-green-500' : 'bg-gray-200'}`} />}
              </div>
            );
          })}
        </div>

        {/* Step content */}
        <div className="flex-1 overflow-y-auto p-6">
          {currentStep.key === 'sources' && (
            <SourcesStep
              domain={domain}
              setDomain={setDomain}
              orgName={orgName}
              setOrgName={setOrgName}
              hints={hints}
              setHints={setHints}
              systems={systems}
            />
          )}
          {currentStep.key === 'generate' && (
            <GenerateStep
              ruleset={ruleset}
              transcript={transcript}
              chatInput={chatInput}
              setChatInput={setChatInput}
              onRefine={handleRefine}
              refining={refining}
              genError={genError}
              llmModel={llmModel}
              elapsedSec={elapsedSec}
            />
          )}
          {currentStep.key === 'save' && (
            <SaveStep
              rulesetName={rulesetName}
              setRulesetName={setRulesetName}
              savedRulesetId={savedRulesetId}
            />
          )}
        </div>

        {/* Footer buttons */}
        <div className="flex justify-between items-center border-t border-gray-200 px-6 py-4 bg-gray-50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
          >
            {savedRulesetId ? 'Close' : 'Cancel'}
          </button>
          <div className="flex gap-2">
            {stepIdx > 0 && !savedRulesetId && (
              <button
                onClick={() => setStepIdx(stepIdx - 1)}
                className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50"
              >
                Back
              </button>
            )}
            {stepIdx === 0 && (
              <button
                onClick={handleGenerate}
                disabled={!domain || generating}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:bg-gray-300"
              >
                {generating ? `Generating… (${elapsedSec}s)` : 'Generate Ruleset'}
              </button>
            )}
            {stepIdx === 1 && (
              <button
                onClick={() => setStepIdx(2)}
                disabled={!ruleset}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:bg-gray-300"
              >
                Continue to Save
              </button>
            )}
            {stepIdx === 2 && !savedRulesetId && (
              <button
                onClick={handleSave}
                disabled={savingRuleset}
                className="px-4 py-2 text-sm bg-green-600 text-white rounded hover:bg-green-700 disabled:bg-gray-300"
              >
                {savingRuleset ? 'Saving…' : 'Save Ruleset'}
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── Step 1: Sources ──
function SourcesStep({ domain, setDomain, orgName, setOrgName, hints, setHints, systems }) {
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Organisation Domain *</label>
        <input
          type="text"
          value={domain}
          onChange={e => setDomain(e.target.value)}
          placeholder="example.com"
          className="w-full px-3 py-2 border rounded"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Organisation Name</label>
        <input
          type="text"
          value={orgName}
          onChange={e => setOrgName(e.target.value)}
          placeholder="Acme Corporation"
          className="w-full px-3 py-2 border rounded"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Additional Context</label>
        <textarea
          value={hints}
          onChange={e => setHints(e.target.value)}
          placeholder="E.g., 'We use service accounts prefixed with svc- and shared mailboxes for teams'"
          rows={4}
          className="w-full px-3 py-2 border rounded"
        />
      </div>
      {systems.length > 0 && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Connected Systems ({systems.length})</label>
          <div className="flex flex-wrap gap-1.5">
            {systems.map(s => (
              <span key={s.id} className="px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded">{s.name}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Step 2: Generate & Refine ──
function GenerateStep({ ruleset, transcript, chatInput, setChatInput, onRefine, refining, genError, llmModel, elapsedSec }) {
  if (!ruleset && !genError) {
    return <div className="text-sm text-gray-500">Generating ruleset…</div>;
  }

  if (genError) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded text-sm text-red-700">
        <strong>Generation failed:</strong> {genError}
      </div>
    );
  }

  const signals = ruleset?.correlation_signals || ruleset?.correlationSignals || [];
  const accountTypes = ruleset?.account_type_rules || ruleset?.accountTypeRules || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-900">Generated Ruleset</h3>
        {llmModel && <span className="text-xs text-gray-500">Model: {llmModel}</span>}
      </div>

      {/* Correlation Signals */}
      <div>
        <h4 className="text-sm font-medium text-gray-700 mb-2">Correlation Signals ({signals.length})</h4>
        <div className="space-y-1">
          {signals.map((s, i) => (
            <div key={i} className="flex items-center justify-between p-2 bg-gray-50 rounded text-xs">
              <div>
                <span className="font-medium text-gray-800">{s.name || s.signal}</span>
                <span className="text-gray-500 ml-2">({s.type})</span>
                {s.description && <p className="text-gray-500 mt-0.5">{s.description}</p>}
              </div>
              <span className={`px-2 py-0.5 rounded font-semibold ${s.weight >= 70 ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                {s.weight}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Account Type Rules */}
      <div>
        <h4 className="text-sm font-medium text-gray-700 mb-2">Account Type Rules ({accountTypes.length})</h4>
        <div className="space-y-1">
          {accountTypes.map((rule, i) => (
            <div key={i} className="p-2 bg-gray-50 rounded text-xs">
              <div className="font-medium text-gray-800">{rule.accountType}</div>
              {rule.patterns && rule.patterns.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {rule.patterns.map((p, pi) => (
                    <code key={pi} className="text-xs bg-white px-1.5 py-0.5 rounded border">{p}</code>
                  ))}
                </div>
              )}
              {rule.description && <p className="text-gray-500 mt-1">{rule.description}</p>}
            </div>
          ))}
        </div>
      </div>

      {/* Chat history */}
      {transcript.length > 0 && (
        <div className="border-t border-gray-200 pt-4">
          <h4 className="text-sm font-medium text-gray-700 mb-2">Refinement History</h4>
          <div className="space-y-2">
            {transcript.map((msg, i) => (
              <div key={i} className={`text-sm ${msg.role === 'user' ? 'text-gray-700' : 'text-gray-500'}`}>
                <strong>{msg.role === 'user' ? 'You' : 'Assistant'}:</strong> {msg.content}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Chat input */}
      <div className="border-t border-gray-200 pt-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">Refine the ruleset</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !refining && onRefine()}
            placeholder="E.g., 'Add a signal for department matching' or 'Remove the fuzzy name match'"
            className="flex-1 px-3 py-2 border rounded text-sm"
            disabled={refining}
          />
          <button
            onClick={onRefine}
            disabled={!chatInput.trim() || refining}
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:bg-gray-300"
          >
            {refining ? `${elapsedSec}s…` : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Step 3: Save ──
function SaveStep({ rulesetName, setRulesetName, savedRulesetId }) {
  if (savedRulesetId) {
    return (
      <div className="p-4 bg-green-50 border border-green-200 rounded">
        <div className="text-sm font-medium text-green-800">Ruleset saved successfully!</div>
        <div className="text-xs text-green-700 mt-1">ID: {savedRulesetId}</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Ruleset Version Name</label>
        <input
          type="text"
          value={rulesetName}
          onChange={e => setRulesetName(e.target.value)}
          placeholder="1.0"
          className="w-full px-3 py-2 border rounded"
        />
      </div>
      <p className="text-sm text-gray-500">
        This ruleset will be saved to the database and can be used for account correlation.
        You can create multiple versions and compare them later.
      </p>
    </div>
  );
}

// ── Modal wrapper ──
function Modal({ onClose, title, children }) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
