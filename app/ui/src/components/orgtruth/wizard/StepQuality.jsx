// Import wizard step 6 — Quality: a dry run (POST /api/org-truth/runs/dry-run
// { sourceId, recipe, linkRules, mode } → report, nothing written) shown as one
// card per entity type: entries, duplicate / empty keys, what a full run would
// close, and per link rule ("Project.owner → Principal", n values scored) the
// unique / ambiguous / none shares as a soft-fill bar; the
// threshold slider (the AccountLinkingSettings range input) writes the threshold
// into every rule; samples of ambiguous and unmatched entries. The verdict
// (wizardDraft.qualityVerdict) decides whether the import may start.
// An activity report (it carries `keys`) shows its parsed rows and key match
// counts instead. Activity and relation imports carry no link rules, so they
// get no threshold slider and no way back to a links step.
import { WizardNav, WIZARD_BACK_CLS } from '@ui/components/crawler/wizardFields';
import { linkBlockLabel, linkShares, qualityVerdict, setThreshold, stepReady } from './wizardDraft';
import { linksTemplate, templateOf } from './templateDraft';
import { useDryRun } from './useDryRun';
import { ActivityPreview } from './templateUi';
import { CARD_CLS, Notice, SMALL_BTN_CLS } from './wizardUi';

const SHARE_FILL = { unique: 'bg-green-300', ambiguous: 'bg-amber-300', none: 'bg-gray-300 dark:bg-gray-500' };
const SHARE_LABEL = { unique: 'unique', ambiguous: 'ambiguous', none: 'none' };

function LinkBar({ stats }) {
  const shares = linkShares(stats);
  return (
    <div>
      <div className="flex h-2 w-full rounded-full overflow-hidden bg-gray-100 dark:bg-gray-700" aria-hidden="true">
        {Object.keys(SHARE_FILL).map(k => <div key={k} className={SHARE_FILL[k]} style={{ width: `${shares[k]}%` }} />)}
      </div>
      <p className="mt-1 text-xs text-gray-700 dark:text-gray-300">
        {Object.keys(SHARE_LABEL).map(k => `${stats[k] ?? 0} ${SHARE_LABEL[k]}`).join(' · ')}
      </p>
    </div>
  );
}

function Samples({ stats }) {
  const ambiguous = stats.samples?.ambiguous ?? [];
  const none = stats.samples?.none ?? [];
  if (!ambiguous.length && !none.length) return null;
  return (
    <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-gray-800 dark:text-gray-200">
      {ambiguous.length > 0 && (
        <div>
          <p className="font-medium mb-1">Ambiguous</p>
          <ul className="space-y-1">
            {ambiguous.map((a, i) => (
              <li key={i}>{a.displayName}: {(a.candidates ?? []).map(c => `${c.label} (${c.confidence} %)`).join(', ')}</li>
            ))}
          </ul>
        </div>
      )}
      {none.length > 0 && (
        <div>
          <p className="font-medium mb-1">No match</p>
          <ul className="space-y-1">{none.map((n, i) => <li key={i}>{n.displayName}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

// One rule's block: "Project.team → Principal", how many values it scored
// (a multi-valued cell counts each value), and the shares.
function LinkBlock({ name, stats }) {
  const label = linkBlockLabel(name, stats);
  return (
    <div className="mt-2" role="group" aria-label={`Links ${label}`}>
      <p className="text-xs font-medium text-gray-800 dark:text-gray-200">{label} · {stats.total ?? 0} values</p>
      <LinkBar stats={stats} />
      <Samples stats={stats} />
    </div>
  );
}

function TypeCard({ type, entity, links, wouldClose }) {
  return (
    <section className={CARD_CLS} aria-label={`Quality of ${type}`}>
      <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{type}</h4>
      <p className="text-sm text-gray-700 dark:text-gray-300">
        {entity?.total ?? 0} entries · {entity?.duplicateKeys ?? 0} duplicate keys · {entity?.emptyKeys ?? 0} empty keys
        {wouldClose > 0 && ` · ${wouldClose} closed by a full import`}
      </p>
      {links.map(([name, stats]) => <LinkBlock key={name} name={name} stats={stats} />)}
    </section>
  );
}

// Link blocks are keyed by rule name; each goes into the card of its entity
// type (a block without one falls back to its key, the pre-`via` shape).
function Report({ draft }) {
  const report = draft.quality;
  const blocks = Object.entries(report.links ?? {});
  const typeOf = ([name, b]) => b.entityType ?? name;
  const types = [...new Set([...Object.keys(report.entities ?? {}), ...blocks.map(typeOf)])];
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-700 dark:text-gray-300">{report.rows ?? 0} rows checked.</p>
      {types.map(t => (
        <TypeCard key={t} type={t} entity={report.entities?.[t]} links={blocks.filter(b => typeOf(b) === t)}
          wouldClose={draft.runMode === 'full' ? report.wouldClose?.[t] ?? 0 : 0} />
      ))}
    </div>
  );
}

function Verdict({ draft }) {
  const v = qualityVerdict(draft.quality, draft.threshold);
  return (
    <div className="space-y-2">
      {v.blockers.map(b => <Notice key={b} variant="error">{b}</Notice>)}
      {v.warnings.map(w => <Notice key={w} variant="warning">{w}</Notice>)}
      {v.canStart && <Notice variant="success">The import can start.</Notice>}
    </div>
  );
}

function ThresholdCard({ draft, update }) {
  return (
      <div className={CARD_CLS}>
        <div className="flex items-center justify-between mb-1">
          <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Link certainty</h4>
          <span className="text-sm font-mono text-gray-700 dark:text-gray-300">&ge; {draft.threshold}%</span>
        </div>
        <input aria-label="Link certainty threshold (percent)" type="range" min="0" max="100" step="5" value={draft.threshold}
          onChange={e => update(d => setThreshold(d, e.target.value))} className="w-full accent-blue-600" />
        <p className="text-xs text-gray-600 dark:text-gray-400">Below it a match is proposed for review instead of linked.</p>
      </div>
  );
}

export default function StepQuality({ draft, update, onBack, onNext, onGoto }) {
  const { busy, notice, check } = useDryRun(draft, update);
  const links = linksTemplate(templateOf(draft.recipe));

  return (
    <div className="space-y-4">
      {links && <ThresholdCard draft={draft} update={update} />}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={check} disabled={busy || !draft.source} className={SMALL_BTN_CLS}>
          {busy ? 'Checking…' : draft.quality ? 'Re-run check' : 'Run check'}
        </button>
        {links && <button type="button" onClick={() => onGoto(5)} className={WIZARD_BACK_CLS}>Back to links</button>}
      </div>

      {notice && <Notice variant="warning">{notice}</Notice>}
      {draft.qualityStale && <Notice variant="warning">The threshold changed since this check. Re-run it before you continue.</Notice>}
      {draft.quality && (draft.quality.keys ? <ActivityPreview report={draft.quality} /> : <Report draft={draft} />)}
      {draft.quality && <Verdict draft={draft} />}

      <WizardNav onBack={onBack} onNext={onNext} nextDisabled={!stepReady(6, draft)} />
    </div>
  );
}
