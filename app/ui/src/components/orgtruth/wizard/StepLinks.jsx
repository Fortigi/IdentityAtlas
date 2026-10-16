// Import wizard step 5 — Links: per entity type, detect which of its attributes
// match which system fields (POST /api/org-truth/links/detect
// { sourceId, recipe, entityType } → candidates
// { attribute, targetType, targetField, type, unique, multiple, none, uniquePct, suggestedWeight }),
// accept candidates as weighted signals, edit weights, remove signals or whole
// rules. Accepting a candidate files it under the rule for its attribute and
// target type ("owner → Principal", "Project name → Resource"), so one entity
// can link several attributes to several target types. Link rules are
// optional: an entity without one is imported but not linked — except for an
// enrichment, which needs the rule that links its list to its target type
// (wizardDraft.enrichKeyRule) before Next opens.
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { WizardNav } from '@ui/components/crawler/wizardFields';
import {
  acceptCandidate, candidateSentence, enrichKeyRule, recipeForApi, removeRule, removeSignal, ruleKey, ruleTitle, setDetection, stepReady, updateSignal,
} from './wizardDraft';
import { templateOf } from './templateDraft';
import { asList, sendJson } from './wizardApi';
import { CARD_CLS, CELL_INPUT_CLS, LINK_BTN_CLS, Notice, SMALL_BTN_CLS } from './wizardUi';

const TH_CLS = 'text-left px-2 py-1 font-medium text-gray-600 dark:text-gray-400';
const TD_CLS = 'px-2 py-1 text-gray-800 dark:text-gray-200';

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

// One rule: the attribute it links through, its target type, its signals.
// `index` is the rule's position in draft.linkRules (how the edits find it).
function RuleSection({ rule, index, update }) {
  const title = ruleTitle(rule);
  return (
    <section className="space-y-2 border-t border-gray-100 dark:border-gray-700 pt-2" aria-label={`Rule ${title}`}>
      <div className="flex items-center justify-between gap-3">
        <h5 className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</h5>
        <button type="button" onClick={() => update(d => removeRule(d, index))} className={LINK_BTN_CLS} aria-label={`Remove rule ${title}`}>
          Remove rule
        </button>
      </div>
      <ul className="space-y-1">
        {rule.signals.map((s, j) => {
          const sig = `${s.attribute} → ${s.targetField} (${s.type})`;
          return (
            <li key={`${s.attribute}|${s.targetField}|${s.type}`} className="flex items-center gap-3 text-sm text-gray-800 dark:text-gray-200">
              <span className="flex-1">{s.attribute} → {rule.targetType}.{s.targetField} ({s.type})</span>
              <input type="number" min="1" max="100" aria-label={`Weight of ${sig} in ${title}`}
                value={s.weight} onChange={e => update(d => updateSignal(d, index, j, { weight: e.target.value }))} className={`${CELL_INPUT_CLS} w-20`} />
              <button type="button" onClick={() => update(d => removeSignal(d, index, j))} className={LINK_BTN_CLS}
                aria-label={`Remove ${sig} from ${title}`}>
                Remove
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RuleList({ type, rules, update }) {
  if (rules.length === 0) return <p className="text-sm text-gray-600 dark:text-gray-400">No link rule: {type} entries are imported but not linked.</p>;
  return rules.map(({ rule, index }) => <RuleSection key={ruleKey(rule)} rule={rule} index={index} update={update} />);
}

function EntityLinks({ draft, type, update }) {
  const { authFetch } = useAuth();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const candidates = draft.detection[type];
  const rules = draft.linkRules.map((rule, index) => ({ rule, index })).filter(x => x.rule.entityType === type);

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
      <RuleList type={type} rules={rules} update={update} />
    </section>
  );
}

function EnrichmentRule({ draft }) {
  const type = draft.recipe.entities[0]?.type ?? '';
  const target = draft.recipe.enrich?.targetType;
  if (enrichKeyRule(draft)) return <Notice variant="success">{type} is linked to {target}: its attributes become attributes of the matched {target}.</Notice>;
  return <Notice variant="warning">Required: a rule that links {type} to {target}. Detect the candidates and accept one on {target}.</Notice>;
}

export default function StepLinks({ draft, update, onBack, onNext }) {
  const types = draft.recipe.entities.map(e => e.type.trim()).filter(Boolean);
  const enrichment = templateOf(draft.recipe) === 'enrichment';
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-700 dark:text-gray-300">
        How should each entity type be matched to accounts, identities, groups or contexts? Detect the candidates and accept the ones that fit.
      </p>
      {enrichment && <EnrichmentRule draft={draft} />}
      {types.map(t => <EntityLinks key={t} draft={draft} type={t} update={update} />)}
      <WizardNav onBack={onBack} onNext={onNext} nextDisabled={!stepReady(5, draft)} />
    </div>
  );
}
