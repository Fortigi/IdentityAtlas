// Identity Atlas v5 — Risk Profile wizard.
//
// Multi-step UX for creating a risk profile + classifiers + (optionally) running
// a scoring pass. Lives behind the "New Risk Profile" button on the Risk Scoring
// admin sub-tab. Steps:
//
//   1. Sources       — domain, org name, hints, optional URLs to scrape
//   2. Generate      — POST /risk-profiles/generate, show the JSON, refine via chat
//   3. Save profile  — name + activate toggle
//   4. Classifiers   — POST /risk-classifiers/generate, review JSON, save
//   5. Score         — POST /risk-scoring/runs (Phase 3), show progress
//
// Steps 4 and 5 can be skipped (user might just want to save the profile).
// All draft state lives in this component — nothing is persisted until the user
// hits "Save". The chat refinement keeps history client-side (each turn POSTs
// the full transcript), so refreshing the page loses the draft. That's the v1
// trade-off; persisting drafts can come later.

import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../auth/AuthGate';
import JsonViewer from './JsonViewer';

const STEPS = [
  { key: 'sources',     label: 'Sources' },
  { key: 'generate',    label: 'Generate & Refine' },
  { key: 'save',        label: 'Save Profile' },
  { key: 'classifiers', label: 'Classifiers' },
  { key: 'score',       label: 'Run Scoring' },
];

export default function RiskProfileWizard({ onClose, onSaved }) {
  const { authFetch } = useAuth();
  const [stepIdx, setStepIdx] = useState(0);
  const [llmReady, setLlmReady] = useState(null); // null=loading, bool

  // ── Step 1 state: sources ──
  const [domain, setDomain] = useState('');
  const [orgName, setOrgName] = useState('');
  const [hints, setHints] = useState('');
  const [urls, setUrls] = useState([]); // [{url, credentialId, status?}]
  const [scrapedSummary, setScrapedSummary] = useState(null);
  const [credList, setCredList] = useState([]);

  // ── Step 2 state: profile draft + chat ──
  const [generating, setGenerating] = useState(false);
  const [profile, setProfile] = useState(null);
  const [transcript, setTranscript] = useState([]); // [{role, content}]
  const [chatInput, setChatInput] = useState('');
  const [refining, setRefining] = useState(false);
  const [llmModel, setLlmModel] = useState(null);
  const [genError, setGenError] = useState(null);
  // Elapsed-time tracker for long LLM calls. Updated every 500ms while any
  // long-running action is in progress so the user sees "12s elapsed" instead
  // of wondering whether the request is stuck.
  const [elapsedMs, setElapsedMs] = useState(0);
  const isWorking = generating || refining;
  useEffect(() => {
    if (!isWorking) { setElapsedMs(0); return; }
    const start = Date.now();
    const interval = setInterval(() => setElapsedMs(Date.now() - start), 500);
    return () => clearInterval(interval);
  }, [isWorking]);
  const elapsedSec = Math.floor(elapsedMs / 1000);


  // ── Step 3 state: save ──
  const [profileName, setProfileName] = useState('');
  const [makeActive, setMakeActive] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savedProfileId, setSavedProfileId] = useState(null);

  // ── Step 4 state: classifiers ──
  const [genClassifiers, setGenClassifiers] = useState(false);
  const [classifiers, setClassifiers] = useState(null);
  const [classifierError, setClassifierError] = useState(null);
  const [classifierName, setClassifierName] = useState('');
  const [savingClassifiers, setSavingClassifiers] = useState(false);
  const [savedClassifierId, setSavedClassifierId] = useState(null);
  const [activateClassifier, setActivateClassifier] = useState(true);

  // ── Step 5 state: scoring ──
  const [scoring, setScoring] = useState(false);
  const [scoringRun, setScoringRun] = useState(null);
  const [scoringError, setScoringError] = useState(null);
  const pollRef = useRef(null);

  // Elapsed-time tracker for the classifier generation step (separate from
  // the Step 2 chat counter so they can run independently).
  const [classifierElapsedMs, setClassifierElapsedMs] = useState(0);
  useEffect(() => {
    if (!genClassifiers) { setClassifierElapsedMs(0); return; }
    const start = Date.now();
    const interval = setInterval(() => setClassifierElapsedMs(Date.now() - start), 500);
    return () => clearInterval(interval);
  }, [genClassifiers]);
  const classifierElapsedSec = Math.floor(classifierElapsedMs / 1000);

  // Check whether the LLM is configured at mount
  useEffect(() => {
    authFetch('/api/admin/llm/status')
      .then(r => r.ok ? r.json() : { configured: false })
      .then(j => setLlmReady(!!j.configured));
  }, [authFetch]);

  // Load scraper credentials for the URL step
  useEffect(() => {
    authFetch('/api/risk-profiles/scraper-credentials')
      .then(r => r.ok ? r.json() : [])
      .then(setCredList)
      .catch(() => setCredList([]));
  }, [authFetch]);

  // Cleanup poll on unmount
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  if (llmReady === null) {
    return <Modal onClose={onClose} title="Risk Profile Wizard"><div className="p-6">Loading…</div></Modal>;
  }
  if (!llmReady) {
    return (
      <Modal onClose={onClose} title="Risk Profile Wizard">
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
    setProfile(null);
    setTranscript([]);
    try {
      const r = await authFetch('/api/risk-profiles/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain,
          organizationName: orgName || undefined,
          hints: hints || undefined,
          urls: urls.filter(u => u.url).map(u => ({ url: u.url, credentialId: u.credentialId || undefined })),
        }),
      });
      let j;
      try { j = await r.json(); }
      catch (e) {
        const text = await r.text().catch(() => '');
        setGenError(`Server returned non-JSON (HTTP ${r.status}): ${text.slice(0, 300) || e.message}`);
        return;
      }
      if (!r.ok) {
        setGenError(j.error || j.message || `HTTP ${r.status}`);
        return;
      }
      if (!j.profile) {
        setGenError('Response had no profile field — check server logs');
        return;
      }
      setProfile(j.profile);
      setLlmModel(j.llmModel);
      setScrapedSummary(j.scraped || []);
      // Default profile name from the generated profile
      if (!profileName && j.profile?.name) setProfileName(j.profile.name);
      setStepIdx(1);
    } catch (err) {
      setGenError(`Network error: ${err.message}`);
    } finally { setGenerating(false); }
  }

  async function handleRefine() {
    if (!chatInput.trim()) return;
    const userMsg = chatInput.trim();
    setRefining(true);
    setChatInput('');
    const newTranscript = [...transcript, { role: 'user', content: userMsg }];
    setTranscript(newTranscript);
    try {
      const r = await authFetch('/api/risk-profiles/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile, transcript: newTranscript, userMessage: userMsg }),
      });
      const j = await r.json();
      if (r.ok) {
        // Show the AI's natural-language reply in the chat. The profile on
        // the left updates silently — the message tells the user what changed.
        const reply = j.assistantMessage || '(profile updated)';
        setTranscript([...newTranscript, { role: 'assistant', content: reply }]);
        if (j.profile) setProfile(j.profile);
        setLlmModel(j.llmModel);
      } else {
        setTranscript([...newTranscript, { role: 'assistant', content: `[error: ${j.error || j.message || r.status}]` }]);
      }
    } catch (err) {
      setTranscript([...newTranscript, { role: 'assistant', content: `[network error: ${err.message}]` }]);
    } finally { setRefining(false); }
  }

  async function handleSaveProfile() {
    setSavingProfile(true);
    try {
      const r = await authFetch('/api/risk-profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: profileName,
          profile,
          transcript,
          sources: scrapedSummary,
          makeActive,
        }),
      });
      const j = await r.json();
      if (r.ok) {
        setSavedProfileId(j.id);
        setStepIdx(3);
      } else {
        alert(j.error || `HTTP ${r.status}`);
      }
    } finally { setSavingProfile(false); }
  }

  async function handleGenerateClassifiers() {
    setGenClassifiers(true);
    setClassifierError(null);
    try {
      const r = await authFetch('/api/risk-classifiers/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: savedProfileId }),
      });
      let j;
      try { j = await r.json(); }
      catch (e) {
        const text = await r.text().catch(() => '');
        setClassifierError(`Server returned non-JSON (HTTP ${r.status}): ${text.slice(0, 300) || e.message}`);
        return;
      }
      if (r.ok) {
        setClassifiers(j.classifiers);
        if (!classifierName) setClassifierName(`${profileName} classifiers`);
      } else {
        setClassifierError(j.error || j.message || `HTTP ${r.status}`);
      }
    } catch (err) {
      setClassifierError(`Network error: ${err.message}`);
    } finally { setGenClassifiers(false); }
  }

  async function handleSaveClassifiers() {
    setSavingClassifiers(true);
    try {
      const r = await authFetch('/api/risk-classifiers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: classifierName,
          profileId: savedProfileId,
          classifiers,
          makeActive: activateClassifier,
        }),
      });
      const j = await r.json();
      if (r.ok) {
        setSavedClassifierId(j.id);
        setStepIdx(4);
      } else {
        alert(j.error || `HTTP ${r.status}`);
      }
    } finally { setSavingClassifiers(false); }
  }

  async function handleStartScoring() {
    setScoring(true);
    setScoringError(null);
    try {
      const r = await authFetch('/api/risk-scoring/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classifierId: savedClassifierId }),
      });
      const j = await r.json();
      if (!r.ok) { setScoringError(j.error || `HTTP ${r.status}`); setScoring(false); return; }
      setScoringRun(j);
      // Poll for progress
      pollRef.current = setInterval(async () => {
        const pr = await authFetch(`/api/risk-scoring/runs/${j.id}`);
        if (pr.ok) {
          const pj = await pr.json();
          setScoringRun(pj);
          if (pj.status === 'completed' || pj.status === 'failed') {
            clearInterval(pollRef.current);
            pollRef.current = null;
            setScoring(false);
          }
        }
      }, 2000);
    } catch (err) {
      setScoringError(err.message);
      setScoring(false);
    }
  }

  // ── URL row handlers ──
  const addUrl = () => setUrls(u => [...u, { url: '', credentialId: '' }]);
  const updateUrl = (i, field, val) => setUrls(u => u.map((row, idx) => idx === i ? { ...row, [field]: val } : row));
  const removeUrl = (i) => setUrls(u => u.filter((_, idx) => idx !== i));

  return (
    <Modal onClose={onClose} title="Risk Profile Wizard" wide>
      {/* Step indicator */}
      <div className="flex items-center gap-2 px-6 py-3 border-b bg-gray-50 text-xs">
        {STEPS.map((s, i) => (
          <div key={s.key} className={`flex items-center gap-2 ${i === stepIdx ? 'font-semibold text-indigo-700' : i < stepIdx ? 'text-green-700' : 'text-gray-400'}`}>
            <span className={`inline-flex w-5 h-5 rounded-full items-center justify-center text-[10px] ${i === stepIdx ? 'bg-indigo-600 text-white' : i < stepIdx ? 'bg-green-600 text-white' : 'bg-gray-200'}`}>{i + 1}</span>
            <span>{s.label}</span>
            {i < STEPS.length - 1 && <span className="text-gray-300 mx-1">›</span>}
          </div>
        ))}
      </div>

      <div className="p-6 max-h-[70vh] overflow-y-auto">
        {/* ── Step 1 — sources ── */}
        {stepIdx === 0 && (
          <div className="space-y-4">
            <h3 className="text-base font-semibold">Tell us about the organisation</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium mb-1">Domain *</label>
                <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="example.com" className="w-full px-3 py-1.5 text-sm border rounded" />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Organisation name (optional)</label>
                <input value={orgName} onChange={e => setOrgName(e.target.value)} placeholder="Acme Corp" className="w-full px-3 py-1.5 text-sm border rounded" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Free-text hints (optional)</label>
              <textarea value={hints} onChange={e => setHints(e.target.value)} rows={3} placeholder="e.g. We're focused on the medical-device division. Skip the consumer products business." className="w-full px-3 py-1.5 text-sm border rounded" />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium">Internal URLs to scrape (optional)</label>
                <button onClick={addUrl} className="text-xs px-2 py-1 rounded border">+ Add URL</button>
              </div>
              {urls.length === 0 && (
                <div className="text-xs text-gray-500">Add wiki, ISMS, intranet pages here. Use credentials for auth-protected URLs (configure them on the Admin → LLM Settings page or below).</div>
              )}
              {urls.map((row, i) => (
                <div key={i} className="flex gap-2 mb-2">
                  <input value={row.url} onChange={e => updateUrl(i, 'url', e.target.value)} placeholder="https://wiki.internal/about" className="flex-1 px-3 py-1.5 text-sm border rounded font-mono" />
                  <select value={row.credentialId} onChange={e => updateUrl(i, 'credentialId', e.target.value)} className="px-3 py-1.5 text-sm border rounded">
                    <option value="">no auth</option>
                    {credList.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </select>
                  <button onClick={() => removeUrl(i)} className="px-2 text-red-600">×</button>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button onClick={onClose} className="px-4 py-1.5 text-sm border rounded">Cancel</button>
              <button onClick={handleGenerate} disabled={!domain || generating} className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:bg-gray-300">
                {generating ? `Generating… (${elapsedSec}s)` : 'Generate profile →'}
              </button>
            </div>
            {generating && (
              <div className="mt-3 p-3 bg-indigo-50 border border-indigo-200 rounded text-sm">
                <div className="flex items-center gap-2 text-indigo-900">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                    <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" className="opacity-75" />
                  </svg>
                  <span className="font-medium">The AI is researching the organisation…</span>
                  <span className="text-xs text-indigo-700 ml-auto">{elapsedSec}s elapsed</span>
                </div>
                <div className="text-xs text-indigo-700 mt-2 space-y-1">
                  <div>1. {urls.filter(u => u.url).length > 0 ? `Scraping ${urls.filter(u => u.url).length} URL${urls.filter(u => u.url).length === 1 ? '' : 's'}` : 'Skipping URL scraping'}</div>
                  <div>2. Calling the LLM to generate the profile JSON</div>
                  <div className="opacity-70 mt-2">This typically takes 20–60 seconds depending on the model. Opus/GPT-4 are slower but produce better industry-specific profiles.</div>
                </div>
              </div>
            )}
            {genError && <div className="text-sm text-red-700 mt-2">{genError}</div>}
          </div>
        )}

        {/* ── Step 2 — generate / refine ── */}
        {stepIdx === 1 && profile && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">Refine the profile</h3>
              <span className="text-xs text-gray-500">model: <code>{llmModel}</code></span>
            </div>
            {scrapedSummary && scrapedSummary.length > 0 && (
              <div className="text-xs bg-gray-50 border rounded p-2">
                <div className="font-medium mb-1">Scraped sources:</div>
                {scrapedSummary.map((s, i) => (
                  <div key={i} className={s.ok ? 'text-green-700' : 'text-red-700'}>
                    {s.ok ? '✓' : '✗'} {s.url} {s.bytes ? `(${s.bytes} bytes)` : s.error || ''}
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Left: profile JSON */}
              <div>
                <div className="text-xs font-medium mb-1">Current profile</div>
                <JsonViewer data={profile} />
              </div>
              {/* Right: chat */}
              <div className="flex flex-col">
                <div className="text-xs font-medium mb-1">Refinement chat</div>
                <div className="flex-1 border rounded p-2 bg-white max-h-96 overflow-auto space-y-2">
                  {transcript.length === 0 && (
                    <div className="text-xs text-gray-500">Ask the AI to adjust anything or ask a question: "drop NIS2 — we're US-only", "what software does this org use?", "add critical role for Customs Officer"…</div>
                  )}
                  {transcript.map((m, i) => (
                    <div key={i} className={`text-xs ${m.role === 'user' ? 'text-gray-900' : 'text-indigo-700'}`}>
                      <span className="font-semibold">{m.role === 'user' ? 'You' : 'AI'}:</span> {m.content}
                    </div>
                  ))}
                  {refining && (
                    <div className="text-xs text-indigo-700 flex items-center gap-2">
                      <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                        <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" className="opacity-75" />
                      </svg>
                      <span className="font-semibold">AI:</span> <em>thinking… ({elapsedSec}s)</em>
                    </div>
                  )}
                </div>
                <div className="flex gap-2 mt-2">
                  <input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleRefine()} disabled={refining} placeholder="Ask for a change or a question…" className="flex-1 px-3 py-1.5 text-sm border rounded" />
                  <button onClick={handleRefine} disabled={!chatInput.trim() || refining} className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:bg-gray-300">
                    {refining ? `${elapsedSec}s` : 'Send'}
                  </button>
                </div>
              </div>
            </div>

            <div className="flex justify-between pt-2">
              <button onClick={() => setStepIdx(0)} className="px-4 py-1.5 text-sm border rounded">← Back</button>
              <button onClick={() => setStepIdx(2)} className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700">Looks good — save →</button>
            </div>
          </div>
        )}

        {/* ── Step 3 — save profile ── */}
        {stepIdx === 2 && (
          <div className="space-y-4 max-w-md">
            <h3 className="text-base font-semibold">Save profile</h3>
            <div>
              <label className="block text-xs font-medium mb-1">Profile name *</label>
              <input value={profileName} onChange={e => setProfileName(e.target.value)} className="w-full px-3 py-1.5 text-sm border rounded" />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={makeActive} onChange={e => setMakeActive(e.target.checked)} />
              Make this the active profile
            </label>
            <div className="flex justify-between pt-2">
              <button onClick={() => setStepIdx(1)} className="px-4 py-1.5 text-sm border rounded">← Back</button>
              <button onClick={handleSaveProfile} disabled={!profileName || savingProfile} className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:bg-gray-300">
                {savingProfile ? 'Saving…' : 'Save profile →'}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 4 — classifiers ── */}
        {stepIdx === 3 && (
          <div className="space-y-4">
            <h3 className="text-base font-semibold">Generate classifiers</h3>
            <p className="text-sm text-gray-600">
              Classifiers are regex patterns that detect high-risk principals by name.
              They're generated from the profile you just saved and applied during scoring.
            </p>
            {!classifiers && (
              <div className="flex gap-2">
                <button onClick={handleGenerateClassifiers} disabled={genClassifiers} className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:bg-gray-300">
                  {genClassifiers ? `Generating… (${classifierElapsedSec}s)` : 'Generate classifiers'}
                </button>
                <button onClick={() => { onSaved?.(); onClose(); }} disabled={genClassifiers} className="px-4 py-1.5 text-sm border rounded disabled:opacity-50">Skip — done for now</button>
              </div>
            )}
            {genClassifiers && (
              <div className="mt-3 p-3 bg-indigo-50 border border-indigo-200 rounded text-sm">
                <div className="flex items-center gap-2 text-indigo-900">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                    <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" className="opacity-75" />
                  </svg>
                  <span className="font-medium">Generating regex classifiers from the profile…</span>
                  <span className="text-xs text-indigo-700 ml-auto">{classifierElapsedSec}s elapsed</span>
                </div>
                <div className="text-xs text-indigo-700 mt-2 space-y-1">
                  <div>The LLM is translating the profile's regulations, critical roles, and known systems into regex patterns that will match high-risk principals during scoring.</div>
                  <div className="opacity-70 mt-2">This typically takes 30–90 seconds with Opus — classifiers are larger than profiles. Switch to Sonnet or Haiku in Admin → LLM Settings for faster (but less nuanced) output.</div>
                </div>
              </div>
            )}
            {classifierError && <div className="text-sm text-red-700 mt-2">{classifierError}</div>}
            {classifiers && (
              <>
                <JsonViewer data={classifiers} />
                <div className="flex items-end gap-3">
                  <div className="flex-1">
                    <label className="block text-xs font-medium mb-1">Classifier set name</label>
                    <input value={classifierName} onChange={e => setClassifierName(e.target.value)} className="w-full px-3 py-1.5 text-sm border rounded" />
                  </div>
                  <label className="flex items-center gap-2 text-sm pb-1.5">
                    <input type="checkbox" checked={activateClassifier} onChange={e => setActivateClassifier(e.target.checked)} />
                    Activate
                  </label>
                </div>
                <div className="flex justify-between pt-2">
                  <button onClick={handleGenerateClassifiers} disabled={genClassifiers} className="px-4 py-1.5 text-sm border rounded">Regenerate</button>
                  <button onClick={handleSaveClassifiers} disabled={!classifierName || savingClassifiers} className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:bg-gray-300">
                    {savingClassifiers ? 'Saving…' : 'Save classifiers →'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Step 5 — score ── */}
        {stepIdx === 4 && (
          <div className="space-y-4 max-w-lg">
            <h3 className="text-base font-semibold">Run scoring</h3>
            <p className="text-sm text-gray-600">
              This applies the saved classifiers to every Principal and Resource and writes the results to the RiskScores table.
              You can also run it later from the Risk Scoring page.
            </p>
            {!scoringRun && !scoring && (
              <div className="flex gap-2">
                <button onClick={handleStartScoring} className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700">
                  Run scoring now
                </button>
                <button onClick={() => { onSaved?.(); onClose(); }} className="px-4 py-1.5 text-sm border rounded">Done</button>
              </div>
            )}
            {scoringError && <div className="text-sm text-red-700">{scoringError}</div>}
            {scoringRun && (
              <div className="space-y-2">
                <div className="text-sm">
                  Status: <span className={`font-semibold ${scoringRun.status === 'completed' ? 'text-green-700' : scoringRun.status === 'failed' ? 'text-red-700' : 'text-indigo-700'}`}>{scoringRun.status}</span>
                  {scoringRun.step && <span className="text-gray-500"> · {scoringRun.step}</span>}
                </div>
                <div className="w-full bg-gray-200 rounded h-2">
                  <div className="bg-indigo-600 h-2 rounded transition-all" style={{ width: `${scoringRun.pct || 0}%` }} />
                </div>
                <div className="text-xs text-gray-500">{scoringRun.scoredEntities || 0} / {scoringRun.totalEntities || '?'} entities</div>
                {scoringRun.errorMessage && <div className="text-sm text-red-700">{scoringRun.errorMessage}</div>}
                {(scoringRun.status === 'completed' || scoringRun.status === 'failed') && (
                  <button onClick={() => { onSaved?.(); onClose(); }} className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700">
                    Done
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ─── Modal shell ─────────────────────────────────────────────────────
function Modal({ children, onClose, title, wide }) {
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className={`bg-white rounded-lg shadow-xl ${wide ? 'max-w-4xl' : 'max-w-md'} w-full`}>
        <div className="flex items-center justify-between px-6 py-3 border-b">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 text-xl leading-none">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
