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
//
// Each step's markup lives in its own RiskProfile*Step child component; this
// file owns the shared draft state, the API handlers, and the step routing.

import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useDialog } from '@ui/components/dialogContext';
import { useElapsedTimer } from '@ui/hooks/useElapsedTimer';
import Stepper from './Stepper';
import RiskProfileSourcesStep from './RiskProfileSourcesStep';
import RiskProfileRefineStep from './RiskProfileRefineStep';
import RiskProfileSaveStep from './RiskProfileSaveStep';
import RiskProfileClassifiersStep from './RiskProfileClassifiersStep';
import RiskProfileScoringStep from './RiskProfileScoringStep';

const STEPS = [
  { key: 'sources',     label: 'Sources' },
  { key: 'generate',    label: 'Generate & Refine' },
  { key: 'save',        label: 'Save Profile' },
  { key: 'classifiers', label: 'Classifiers' },
  { key: 'score',       label: 'Run Scoring' },
];

export default function RiskProfileWizard({ onClose, onSaved }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
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
  // Elapsed-time trackers for the long LLM calls so the user sees "12s elapsed"
  // instead of wondering whether the request is stuck.
  const isWorking = generating || refining;
  const elapsedSec = useElapsedTimer(isWorking);

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
  // Separate counter from the Step 2 chat so they run independently.
  const classifierElapsedSec = useElapsedTimer(genClassifiers);

  // ── Step 5 state: scoring ──
  const [scoring, setScoring] = useState(false);
  const [scoringRun, setScoringRun] = useState(null);
  const [scoringError, setScoringError] = useState(null);
  const pollRef = useRef(null);

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
    return <Modal onClose={onClose} title="Risk Profile Wizard"><div className="p-6 dark:text-gray-300">Loading…</div></Modal>;
  }
  if (!llmReady) {
    return (
      <Modal onClose={onClose} title="Risk Profile Wizard">
        <div className="p-6">
          <div className="text-sm text-amber-700 dark:text-amber-400">
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
        dialog.alert(j.error || `HTTP ${r.status}`);
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
        dialog.alert(j.error || `HTTP ${r.status}`);
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
      <div className="px-6 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/50">
        <Stepper steps={STEPS.map((s, i) => ({ n: i + 1, label: s.label }))} current={stepIdx + 1} />
      </div>

      <div className="p-6 max-h-[70vh] overflow-y-auto">
        {stepIdx === 0 && (
          <RiskProfileSourcesStep
            domain={domain} setDomain={setDomain}
            orgName={orgName} setOrgName={setOrgName}
            hints={hints} setHints={setHints}
            urls={urls} addUrl={addUrl} updateUrl={updateUrl} removeUrl={removeUrl}
            credList={credList} onClose={onClose}
            handleGenerate={handleGenerate} generating={generating}
            elapsedSec={elapsedSec} genError={genError}
          />
        )}

        {stepIdx === 1 && profile && (
          <RiskProfileRefineStep
            llmModel={llmModel} scrapedSummary={scrapedSummary} profile={profile}
            transcript={transcript} refining={refining} elapsedSec={elapsedSec}
            chatInput={chatInput} setChatInput={setChatInput}
            handleRefine={handleRefine} setStepIdx={setStepIdx}
          />
        )}

        {stepIdx === 2 && (
          <RiskProfileSaveStep
            profileName={profileName} setProfileName={setProfileName}
            makeActive={makeActive} setMakeActive={setMakeActive}
            savingProfile={savingProfile} handleSaveProfile={handleSaveProfile}
            setStepIdx={setStepIdx}
          />
        )}

        {stepIdx === 3 && (
          <RiskProfileClassifiersStep
            classifiers={classifiers} genClassifiers={genClassifiers}
            classifierElapsedSec={classifierElapsedSec} classifierError={classifierError}
            classifierName={classifierName} setClassifierName={setClassifierName}
            activateClassifier={activateClassifier} setActivateClassifier={setActivateClassifier}
            savingClassifiers={savingClassifiers}
            handleGenerateClassifiers={handleGenerateClassifiers}
            handleSaveClassifiers={handleSaveClassifiers}
            onSaved={onSaved} onClose={onClose}
          />
        )}

        {stepIdx === 4 && (
          <RiskProfileScoringStep
            scoring={scoring} scoringRun={scoringRun} scoringError={scoringError}
            handleStartScoring={handleStartScoring} onSaved={onSaved} onClose={onClose}
          />
        )}
      </div>
    </Modal>
  );
}

// ─── Modal shell ─────────────────────────────────────────────────────
function Modal({ children, onClose, title, wide }) {
  return (
    <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-50 flex items-center justify-center p-4">
      <div className={`bg-white dark:bg-gray-800 rounded-lg shadow-xl ${wide ? 'max-w-4xl' : 'max-w-md'} w-full`}>
        <div className="flex items-center justify-between px-6 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-base font-semibold dark:text-white">{title}</h2>
          <button onClick={onClose} className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-xl leading-none">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
