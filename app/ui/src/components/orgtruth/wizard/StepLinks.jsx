// Import wizard step 4 — Links: per entity type, detect which of its attributes
// match which system fields (POST /api/org-truth/links/detect
// { sourceId, recipe, entityType } → candidates
// { attribute, targetType, targetField, type, unique, multiple, none, uniquePct, suggestedWeight }),
// accept candidates as weighted signals, edit weights, remove signals, change
// the target type. Link rules are optional: an entity without one is imported
// but not linked.
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { WizardNav } from '@ui/components/crawler/wizardFields';
import {
  LINK_TARGETS, acceptCandidate, candidateSentence, recipeForApi, removeSignal, setDetection, setRuleTarget, stepReady, updateSignal,
} from './wizardDraft';
import { asList, sendJson } from './wizardApi';
import { CARD_CLS, CELL_INPUT_CLS, CellSelect, LINK_BTN_CLS, Notice, SMALL_BTN_CLS } from './wizardUi';

const TH_CLS = 'text-left px-2 py-1 font-medium text-gray-600 dark:text-gray-400';
const TD_CLS = 'px-2 py-1 text-gray-800 dark:text-gray-200';
const TARGET_TYPES = Object.keys(LINK_TARGETS);

function CandidateTable({ type, candidates, update }) {
  if (candidates.length === 0) return <Notice>No attribute of {type} matches a system field uniquely.</Notice>;
  return (
    <table className="w-full text-sm">
      <thead className="bg-gray-50 dark:bg-gray-700/50">
        <tr>
          <th className={TH_CLS}>Attribute</th><th className={TH_CLS}>System field</th><th className={TH_CLS}>Match</th>
          <th className={TH_CLS}>Unique</th><th className={TH_CLS}>Multiple</th><th className={TH_CLS}>None</th><th className={TH_CLS}><span className="sr-only">Accept</span></th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
        {candidates.map(c => (
          <tr key={`${c.attribute}|${c.targetType}|${c.targetField}|${c.type}`} title={candidateSentence(type, c)}>
            <td className={TD_CLS}>{c.attribute}</td>
            <td className={TD_CLS}>{c.targetType}.{c.targetField}</td>
            <td className={TD_CLS}>{c.type}</td>
            <td className={TD_CLS}>{Math.round(c.uniquePct ?? 0)} %</td>
            <td className={TD_CLS}>{c.multiple}</td>
            <td className={TD_CLS}>{c.none}</td>
            <td className={TD_CLS}>
              <button type="button" onClick={() => update(d => acceptCandidate(d, type, c))} className={LINK_BTN_CLS}
                aria-label={`Accept: ${candidateSentence(type, c)} (${c.type})`}>
                Accept
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RuleEditor({ type, rule, update }) {
  if (!rule) return <p className="text-sm text-gray-600 dark:text-gray-400">No link rule: {type} entries are imported but not linked.</p>;
  return (
    <div className="space-y-2">
      <div className="max-w-xs">
        <CellSelect label={`${type} links to`} value={rule.targetType} options={TARGET_TYPES} onChange={t => update(d => setRuleTarget(d, type, t))} />
      </div>
      <ul className="space-y-1">
        {rule.signals.map((s, j) => (
          <li key={`${s.attribute}|${s.targetField}|${s.type}`} className="flex items-center gap-3 text-sm text-gray-800 dark:text-gray-200">
            <span className="flex-1">{s.attribute} → {rule.targetType}.{s.targetField} ({s.type})</span>
            <input type="number" min="1" max="100" aria-label={`Weight of ${s.attribute} → ${s.targetField} (${s.type})`}
              value={s.weight} onChange={e => update(d => updateSignal(d, type, j, { weight: e.target.value }))} className={`${CELL_INPUT_CLS} w-20`} />
            <button type="button" onClick={() => update(d => removeSignal(d, type, j))} className={LINK_BTN_CLS}
              aria-label={`Remove ${s.attribute} → ${s.targetField} (${s.type})`}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EntityLinks({ draft, type, update }) {
  const { authFetch } = useAuth();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const candidates = draft.detection[type];
  const rule = draft.linkRules.find(r => r.entityType === type);

  const detect = async () => {
    setNotice(null);
    setBusy(true);
    try {
      const body = await sendJson(authFetch, '/links/detect', { sourceId: draft.source?.id, recipe: recipeForApi(draft.recipe), entityType: type });
      update(d => setDetection(d, type, asList(body, 'candidates')));
    } catch (e) {
      setNotice(e.notAvailable ? e.message : `Detection failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`${CARD_CLS} space-y-3`} aria-label={`Links for ${type}`}>
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{type}</h4>
        <button type="button" onClick={detect} disabled={busy} className={SMALL_BTN_CLS} aria-label={`Detect candidates for ${type}`}>
          {busy ? 'Detecting…' : 'Detect candidates'}
        </button>
      </div>
      {notice && <Notice variant="warning">{notice}</Notice>}
      {candidates && <CandidateTable type={type} candidates={candidates} update={update} />}
      <RuleEditor type={type} rule={rule} update={update} />
    </section>
  );
}

export default function StepLinks({ draft, update, onBack, onNext }) {
  const types = draft.recipe.entities.map(e => e.type.trim()).filter(Boolean);
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-700 dark:text-gray-300">
        How should each entity type be matched to accounts, identities, groups or contexts? Detect the candidates and accept the ones that fit.
      </p>
      {types.map(t => <EntityLinks key={t} draft={draft} type={t} update={update} />)}
      <WizardNav onBack={onBack} onNext={onNext} nextDisabled={!stepReady(4, draft)} />
    </div>
  );
}
