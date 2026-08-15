import { useState } from 'react';
import { TIER_STYLES } from '@ui/utils/tierStyles';
import {
  parseJSON,
  formatScoredAt,
  clampScore,
  signPrefix,
  classifierScoreClass,
  reasonText,
  humanizeLayerKey,
  adjustmentColorClass,
  overrideBadgeClass,
} from './RiskScoreSection.helpers';

function TierBadge({ tier }) {
  const s = TIER_STYLES[tier] || TIER_STYLES.None;
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${s.bg} ${s.text} ${s.darkBg} ${s.darkText} ${s.border} ${s.darkBorder} border`}>
      <span className={`w-2 h-2 rounded-full ${s.dot}`} />
      {tier || 'None'}
    </span>
  );
}

function ScoreBar({ score, tier, maxScore = 100, width = 'w-32' }) {
  const pct = Math.min(100, Math.max(0, (score / maxScore) * 100));
  // Colour by the backend-provided tier via the shared TIER_STYLES map — the
  // single UI source of tier→colour — rather than re-deriving cutoffs here (they
  // used to duplicate, and drift from, the engine's tierFor thresholds).
  const color = (TIER_STYLES[tier] || TIER_STYLES.None).dot;
  return (
    <div className="flex items-center gap-2">
      <div className={`${width} h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden`}>
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-gray-600 dark:text-gray-400 w-6 text-right">{score ?? 0}</span>
    </div>
  );
}

// RISK_FIELDS (the field names excluded from the generic Attributes table) lives
// in RiskScoreSection.constants.js so this file only exports its component.

function RiskHeader({ scoredAt }) {
  return (
    <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
      Risk Assessment
      {scoredAt && (
        <span className="text-xs font-normal text-gray-600 dark:text-gray-500">
          scored {formatScoredAt(scoredAt)}
        </span>
      )}
    </h3>
  );
}

// Summary row: tier badge + score bar + optional analyst-override badge.
function RiskSummaryRow({ tier, effectiveScore, localOverride }) {
  return (
    <div className="flex items-center gap-4 mb-3">
      <TierBadge tier={tier} />
      <div className="flex-1">
        <ScoreBar score={effectiveScore} tier={tier} width="w-full" />
      </div>
      {localOverride != null && (
        <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${overrideBadgeClass(localOverride)}`}>
          override: {signPrefix(localOverride)}{localOverride}
        </span>
      )}
    </div>
  );
}

// Per-layer score breakdown — always visible.
function RiskLayerBreakdown({ layers }) {
  return (
    <div className="grid grid-cols-4 gap-3 mb-3">
      {layers.map(l => (
        <div key={l.key} className="text-center">
          <div className="text-[10px] text-gray-600 dark:text-gray-500 uppercase tracking-wide mb-1">{l.label}</div>
          <div className="text-lg font-semibold text-gray-800 dark:text-gray-200">{l.score ?? 0}</div>
          <div className="text-[10px] text-gray-600 dark:text-gray-500">{l.weight} weight</div>
        </div>
      ))}
    </div>
  );
}

function RiskActionButtons({ detailsOpen, onToggleDetails, hasOverride, onToggleOverride }) {
  return (
    <div className="flex items-center gap-2 border-t border-gray-100 dark:border-gray-700 pt-3">
      <button
        onClick={onToggleDetails}
        className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 border border-gray-200 dark:border-gray-600 rounded px-2 py-1 hover:bg-gray-50 dark:hover:bg-gray-700"
      >
        {detailsOpen ? 'Hide Details' : 'Show Details'}
      </button>
      <button
        onClick={onToggleOverride}
        className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 border border-gray-200 dark:border-gray-600 rounded px-2 py-1 hover:bg-gray-50 dark:hover:bg-gray-700"
      >
        {hasOverride ? 'Edit Override' : 'Adjust Score'}
      </button>
    </div>
  );
}

function ClassifierMatchRow({ match }) {
  return (
    <div className="flex items-start gap-2 text-xs bg-gray-50 dark:bg-gray-700/50 rounded px-2 py-1.5">
      <span className={`shrink-0 px-1.5 py-0.5 rounded font-mono text-[10px] ${classifierScoreClass(match.score)}`}>
        {match.score}
      </span>
      <span className="text-gray-500 dark:text-gray-400 shrink-0">{match.category || match.id}</span>
      {match.rationale && <span className="text-gray-700 dark:text-gray-300">{match.rationale}</span>}
    </div>
  );
}

function ClassifierMatchesBlock({ matches }) {
  if (!matches || matches.length === 0) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1.5">Classifier Matches</h4>
      <div className="space-y-1">
        {matches.map((m, i) => <ClassifierMatchRow key={i} match={m} />)}
      </div>
    </div>
  );
}

function ReasonList({ reasons }) {
  return (
    <ul className="text-xs text-gray-600 dark:text-gray-400 list-disc list-inside space-y-0.5">
      {reasons.map((r, i) => <li key={i}>{reasonText(r)}</li>)}
    </ul>
  );
}

function ExplanationLayer({ layerKey, layerData }) {
  const reasons = layerData?.reasons || layerData;
  if (!reasons || (Array.isArray(reasons) && reasons.length === 0)) return null;
  return (
    <div>
      <div className="text-[10px] text-gray-600 dark:text-gray-500 uppercase tracking-wide mb-0.5">
        {humanizeLayerKey(layerKey)}
      </div>
      {Array.isArray(reasons)
        ? <ReasonList reasons={reasons} />
        : <p className="text-xs text-gray-600 dark:text-gray-400">{JSON.stringify(reasons)}</p>}
    </div>
  );
}

function ScoreExplanationBlock({ explanation }) {
  if (!explanation) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1.5">Score Explanation</h4>
      <div className="space-y-2">
        {Object.entries(explanation).map(([layerKey, layerData]) => (
          <ExplanationLayer key={layerKey} layerKey={layerKey} layerData={layerData} />
        ))}
      </div>
    </div>
  );
}

function OverrideReasonBlock({ reason }) {
  if (!reason) return null;
  return (
    <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded px-3 py-2">
      <div className="text-[10px] text-amber-600 dark:text-amber-400 uppercase tracking-wide mb-0.5">Analyst Override Reason</div>
      <p className="text-xs text-amber-800 dark:text-amber-300">{reason}</p>
    </div>
  );
}

// Expanded details: classifier matches, per-layer explanation, override reason.
function RiskDetailsPanel({ classifierMatches, explanation, localOverrideReason }) {
  return (
    <div className="mt-3 border-t border-gray-100 dark:border-gray-700 pt-3 space-y-3">
      <ClassifierMatchesBlock matches={classifierMatches} />
      <ScoreExplanationBlock explanation={explanation} />
      <OverrideReasonBlock reason={localOverrideReason} />
    </div>
  );
}

// Analyst override form: adjustment slider + reason + save/remove.
function RiskOverrideForm({
  adjustment, setAdjustment, reason, setReason, saving,
  hasOverride, score, onSave, onRemove, onCancel,
}) {
  const saveDisabled = saving || adjustment === 0 || !reason.trim() || reason.trim().length < 3;
  return (
    <div className="mt-3 border-t border-gray-100 dark:border-gray-700 pt-3">
      <div className="bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-lg p-3 space-y-3">
        <div className="flex items-center justify-between">
          <h5 className="text-xs font-semibold text-gray-700 dark:text-gray-300">Analyst Override</h5>
          <button onClick={onCancel} className="text-gray-600 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-xs">Cancel</button>
        </div>

        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
            Score Adjustment ({signPrefix(adjustment)}{adjustment})
          </label>
          <input
            type="range" min={-50} max={50} value={adjustment}
            onChange={e => setAdjustment(parseInt(e.target.value))}
            className="w-full h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer"
          />
          <div className="flex justify-between text-[10px] text-gray-600 dark:text-gray-500 mt-0.5">
            <span>-50 (lower risk)</span>
            <span className={`font-mono font-bold ${adjustmentColorClass(adjustment)}`}>
              {signPrefix(adjustment)}{adjustment}
            </span>
            <span>+50 (higher risk)</span>
          </div>
        </div>

        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Reason (required)</label>
          <textarea
            value={reason} onChange={e => setReason(e.target.value)}
            placeholder="Explain why you're adjusting this score..."
            className="w-full text-sm border border-gray-200 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 rounded-lg px-2 py-1.5 placeholder-gray-400 dark:placeholder-gray-500 resize-none"
            rows={2} maxLength={500}
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onSave}
            disabled={saveDisabled}
            className="px-3 py-1 text-xs font-medium text-white bg-gray-900 dark:bg-gray-600 rounded-lg disabled:opacity-40 hover:bg-gray-800 dark:hover:bg-gray-500"
          >
            {saving ? 'Saving...' : 'Save Override'}
          </button>
          {hasOverride && (
            <button
              onClick={onRemove} disabled={saving}
              className="px-3 py-1 text-xs font-medium text-red-700 dark:text-red-400 border border-red-200 dark:border-red-700 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-40"
            >
              Remove Override
            </button>
          )}
          {adjustment !== 0 && (
            <span className="text-xs text-gray-600 dark:text-gray-500">
              Effective: {score} {signPrefix(adjustment)}{adjustment} = {clampScore(score + adjustment)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Risk Assessment section for User/Group detail pages.
 * Only renders if riskScore is present (not null/undefined).
 */
export default function RiskScoreSection({ attributes, entityType, entityId, authFetch }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [adjustment, setAdjustment] = useState(attributes.riskOverride || 0);
  const [reason, setReason] = useState(attributes.riskOverrideReason || '');
  const [saving, setSaving] = useState(false);
  const [localOverride, setLocalOverride] = useState(attributes.riskOverride);
  const [localOverrideReason, setLocalOverrideReason] = useState(attributes.riskOverrideReason);

  // Don't render if no risk data
  if (attributes.riskScore == null && attributes.riskTier == null) return null;

  const score = attributes.riskScore ?? 0;
  const tier = attributes.riskTier || 'None';
  const explanation = parseJSON(attributes.riskExplanation);
  const classifierMatches = parseJSON(attributes.riskClassifierMatches);

  const layers = [
    { key: 'direct',     label: 'Classifier Match',   score: attributes.riskDirectScore,     weight: '50%' },
    { key: 'membership', label: 'Membership Analysis', score: attributes.riskMembershipScore, weight: '20%' },
    { key: 'structural', label: 'Structural / Hygiene', score: attributes.riskStructuralScore, weight: '10%' },
    { key: 'propagated', label: 'Risk Propagation',    score: attributes.riskPropagatedScore,  weight: '20%' },
  ];

  const effectiveScore = localOverride != null ? clampScore(score + localOverride) : score;

  const type = entityType === 'user' ? 'users' : 'groups';

  const handleSaveOverride = async () => {
    if (!reason.trim() || reason.trim().length < 3 || adjustment === 0) return;
    setSaving(true);
    try {
      const res = await authFetch(`/api/risk-scores/${type}/${entityId}/override`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adjustment, reason: reason.trim() }),
      });
      if (res.ok) {
        setLocalOverride(adjustment);
        setLocalOverrideReason(reason.trim());
        setOverrideOpen(false);
      }
    } catch (err) {
      console.error('Failed to save override:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveOverride = async () => {
    setSaving(true);
    try {
      const res = await authFetch(`/api/risk-scores/${type}/${entityId}/override`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setLocalOverride(null);
        setLocalOverrideReason(null);
        setAdjustment(0);
        setReason('');
        setOverrideOpen(false);
      }
    } catch (err) {
      console.error('Failed to remove override:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 mb-4">
      <RiskHeader scoredAt={attributes.riskScoredAt} />

      <RiskSummaryRow tier={tier} effectiveScore={effectiveScore} localOverride={localOverride} />

      <RiskLayerBreakdown layers={layers} />

      <RiskActionButtons
        detailsOpen={detailsOpen}
        onToggleDetails={() => setDetailsOpen(v => !v)}
        hasOverride={localOverride != null}
        onToggleOverride={() => setOverrideOpen(v => !v)}
      />

      {detailsOpen && (
        <RiskDetailsPanel
          classifierMatches={classifierMatches}
          explanation={explanation}
          localOverrideReason={localOverrideReason}
        />
      )}

      {overrideOpen && (
        <RiskOverrideForm
          adjustment={adjustment}
          setAdjustment={setAdjustment}
          reason={reason}
          setReason={setReason}
          saving={saving}
          hasOverride={localOverride != null}
          score={score}
          onSave={handleSaveOverride}
          onRemove={handleRemoveOverride}
          onCancel={() => setOverrideOpen(false)}
        />
      )}
    </div>
  );
}
