import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import WizardShell from '@ui/components/WizardShell';
import BusinessRoleLifecycle from '@ui/components/businessRoles/BusinessRoleLifecycle';
import BusinessRoleResources from '@ui/components/businessRoles/BusinessRoleResources';
import StepVerdict from './StepVerdict';
import HoldersPanel from './HoldersPanel';
import { CurrentOwners, ProposedOwners } from './OwnershipStep';
import ReviewRecord from './ReviewRecord';
import ImprovementsStep from './ImprovementsStep';
import { STEP_INFO, SIGN_STEP, buildBody, emptyAnswers, outcomeText, stepLabel, stepProblem } from './reviewSteps';
import { IMPROVEMENTS, judgedImprovements } from './improvementSteps';

// ─── The composition review wizard ───────────────────────────────────────
// Opens when someone says "I want to review this role". One screen per step the
// review asks (`steps`, from the API: today all of them, later whatever a
// campaign asks), each ending in a verdict, and a last screen to sign. Nothing
// is saved until the reviewer signs: then the whole review goes in one request.
// A review with findings is still a review; signing is not agreeing.
//
// The improvements step is the one without three choices: the reviewer decides
// on each suggestion role mining makes, asked for as the wizard opens.

const MUTED = 'text-sm text-gray-600 dark:text-gray-400';
const PRIMARY = 'rounded bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50';
const SECONDARY = 'rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-800 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700/50';

function StepBody({ step, roleId, data, current, onOpenDetail }) {
  if (step === 'ownership') return <CurrentOwners snapshot={current} />;
  if (step === 'lifecycle') {
    return (
      <>
        <BusinessRoleLifecycle roleId={roleId} data={data} onOpenDetail={onOpenDetail} />
        <HoldersPanel roleId={roleId} />
      </>
    );
  }
  if (step === 'contents') return <BusinessRoleResources roleId={roleId} onOpenDetail={onOpenDetail} />;
  return null;
}

function SignStep({ steps, answers, current, found, notes, onNotes }) {
  const judged = steps.map(step => (step === IMPROVEMENTS ? judgedImprovements(answers[step], found) : { step, ...answers[step] }));
  return (
    <div className="space-y-4">
      <section aria-label="Your review" className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h4 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">Your review: {outcomeText(judged)}</h4>
        <ReviewRecord steps={judged} snapshot={current} />
      </section>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-gray-900 dark:text-gray-100">Anything else?</span>
        <textarea value={notes} onChange={e => onNotes(e.target.value)} rows={4} maxLength={10000}
          placeholder="General comments or suggestions to improve this role (optional)"
          className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500" />
      </label>
      <p className={MUTED}>
        By signing you confirm that you reviewed this role as it is shown today. A review with findings is a finished review too:
        signing does not mean you agree with everything.
      </p>
    </div>
  );
}

export default function ReviewWizard({ roleId, data, steps, verdicts, current, onSave, onCancel, onOpenDetail }) {
  const screens = [...steps, SIGN_STEP];
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState(() => emptyAnswers(steps, current));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { authFetch } = useAuth();
  const mining = useFetch(`/api/access-package/${encodeURIComponent(roleId)}/composition-reviews/improvements`, { authFetch, enabled: steps.includes(IMPROVEMENTS) });
  const found = mining.error ? null : mining.data;
  const screen = screens[index];
  const signing = screen === SIGN_STEP;
  const answer = answers[screen];
  const problem = signing ? null : stepProblem(screen, answer, current, found);
  const setAnswer = (next) => setAnswers(prev => ({ ...prev, [screen]: next }));
  const go = (to) => { setError(null); setIndex(to); };

  async function sign() {
    setBusy(true);
    setError(null);
    const failure = await onSave(buildBody(steps, answers, notes, current, found));
    setBusy(false);
    if (!failure) return;
    setError(failure);
    // The data moved on while they reviewed: ask role mining again, from that step.
    if (steps.includes(IMPROVEMENTS) && /suggestions changed/i.test(failure)) {
      mining.reload();
      setAnswers(prev => ({ ...prev, [IMPROVEMENTS]: { ...prev[IMPROVEMENTS], decisions: {} } }));
      setIndex(steps.indexOf(IMPROVEMENTS));
    }
  }

  const stepper = screens.map((s, i) => ({ n: i + 1, label: s === SIGN_STEP ? 'Sign' : stepLabel(s) }));
  return (
    <div data-testid="review-wizard">
      <WizardShell title="Review this role" onCancel={onCancel} cancelDisabled={busy} steps={stepper} currentStep={index + 1}
        onStepClick={n => go(n - 1)} error={error}>
        <div className="space-y-4">
          {signing && <SignStep steps={steps} answers={answers} current={current} found={found} notes={notes} onNotes={setNotes} />}
          {screen === IMPROVEMENTS && (
            <>
              <p className={MUTED}>{STEP_INFO[screen].help}</p>
              <ImprovementsStep found={found} loading={mining.loading} error={mining.error} onRetry={mining.reload} answer={answer} onChange={setAnswer} />
            </>
          )}
          {!signing && screen !== IMPROVEMENTS && (
            <>
              <p className={MUTED}>{STEP_INFO[screen]?.help}</p>
              <StepBody step={screen} roleId={roleId} data={data} current={current} onOpenDetail={onOpenDetail} />
              <StepVerdict step={screen} question={STEP_INFO[screen]?.question ?? stepLabel(screen)} verdicts={verdicts} answer={answer} onChange={setAnswer}>
                {screen === 'ownership' && (
                  <ProposedOwners roleId={roleId} snapshot={current} proposal={answer.proposal}
                    onChange={proposal => setAnswer({ ...answer, proposal })} />
                )}
              </StepVerdict>
            </>
          )}
          <div className="flex items-center justify-between gap-3">
            <button type="button" className={SECONDARY} onClick={() => go(index - 1)} disabled={index === 0 || busy}>Back</button>
            <div className="flex items-center gap-3">
              {problem && (answer?.verdict || screen === IMPROVEMENTS) && <span className="text-xs text-amber-800 dark:text-amber-300">{problem}</span>}
              {signing
                ? <button type="button" className={PRIMARY} onClick={sign} disabled={busy}>{busy ? 'Saving…' : 'Sign and finish the review'}</button>
                : <button type="button" className={PRIMARY} onClick={() => go(index + 1)} disabled={!!problem}>Next</button>}
            </div>
          </div>
        </div>
      </WizardShell>
    </div>
  );
}
