import { useState } from 'react';
import { TIER_STYLES } from '../utils/tierStyles';

function TierBadge({ tier }) {
  const s = TIER_STYLES[tier] || TIER_STYLES.None;
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${s.bg} ${s.text} ${s.darkBg} ${s.darkText} ${s.border} ${s.darkBorder} border`}>
      <span className={`w-2 h-2 rounded-full ${s.dot}`} />
      {tier || 'None'}
    </span>
  );
}

function ScoreBar({ score, maxScore = 100, width = 'w-32' }) {
  const pct = Math.min(100, Math.max(0, (score / maxScore) * 100));
  const color = score >= 90 ? 'bg-red-500' : score >= 70 ? 'bg-orange-500' : score >= 40 ? 'bg-yellow-500' : score >= 20 ? 'bg-blue-400' : 'bg-gray-300';
  return (
    <div className="flex items-center gap-2">
      <div className={`${width} h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden`}>
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-gray-600 dark:text-gray-400 w-6 text-right">{score ?? 0}</span>
    </div>
  );
}

// ─── Risk field names (to exclude from generic Attributes table) ─────
export const RISK_FIELDS = new Set([
  'riskScore', 'riskTier', 'riskDirectScore', 'riskMembershipScore',
  'riskStructuralScore', 'riskPropagatedScore', 'riskClassifierMatches',
  'riskExplanation', 'riskScoredAt', 'riskOverride', 'riskOverrideReason',
]);

function parseJSON(val) {
  if (!val || val === '\u2014') return null;
  try { return typeof val === 'string' ? JSON.parse(val) : val; }
  catch { return null; }
}

function formatScoredAt(val) {
  if (!val) return null;
  const d = new Date(val);
  if (isNaN(d)) return String(val);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
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

  const effectiveScore = localOverride != null
    ? Math.max(0, Math.min(100, score + localOverride))
    : score;

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
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
        Risk Assessment
        {attributes.riskScoredAt && (
          <span className="text-xs font-normal text-gray-400 dark:text-gray-500">
            scored {formatScoredAt(attributes.riskScoredAt)}
          </span>
        )}
      </h3>

      {/* Summary row: tier badge + score bar + override */}
      <div className="flex items-center gap-4 mb-3">
        <TierBadge tier={tier} />
        <div className="flex-1">
          <ScoreBar score={effectiveScore} width="w-full" />
        </div>
        {localOverride != null && (
          <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${
            localOverride > 0 ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
          }`}>
            override: {localOverride > 0 ? '+' : ''}{localOverride}
          </span>
        )}
      </div>

      {/* Layer breakdown - always visible */}
      <div className="grid grid-cols-4 gap-3 mb-3">
        {layers.map(l => (
          <div key={l.key} className="text-center">
            <div className="text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-wide mb-1">{l.label}</div>
            <div className="text-lg font-semibold text-gray-800 dark:text-gray-200">{l.score ?? 0}</div>
            <div className="text-[10px] text-gray-400 dark:text-gray-500">{l.weight} weight</div>
          </div>
        ))}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2 border-t border-gray-100 dark:border-gray-700 pt-3">
        <button
          onClick={() => setDetailsOpen(v => !v)}
          className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 border border-gray-200 dark:border-gray-600 rounded px-2 py-1 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          {detailsOpen ? 'Hide Details' : 'Show Details'}
        </button>
        <button
          onClick={() => setOverrideOpen(v => !v)}
          className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 border border-gray-200 dark:border-gray-600 rounded px-2 py-1 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          {localOverride != null ? 'Edit Override' : 'Adjust Score'}
        </button>
      </div>

      {/* Expanded details */}
      {detailsOpen && (
        <div className="mt-3 border-t border-gray-100 dark:border-gray-700 pt-3 space-y-3">
          {/* Classifier matches */}
          {classifierMatches && classifierMatches.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1.5">Classifier Matches</h4>
              <div className="space-y-1">
                {classifierMatches.map((m, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs bg-gray-50 dark:bg-gray-700/50 rounded px-2 py-1.5">
                    <span className={`shrink-0 px-1.5 py-0.5 rounded font-mono text-[10px] ${
                      m.score >= 70 ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' : m.score >= 40 ? 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                    }`}>
                      {m.score}
                    </span>
                    <span className="text-gray-500 dark:text-gray-400 shrink-0">{m.category || m.id}</span>
                    {m.rationale && <span className="text-gray-700 dark:text-gray-300">{m.rationale}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Per-layer explanation */}
          {explanation && (
            <div>
              <h4 className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1.5">Score Explanation</h4>
              <div className="space-y-2">
                {Object.entries(explanation).map(([layerKey, layerData]) => {
                  const reasons = layerData?.reasons || layerData;
                  if (!reasons || (Array.isArray(reasons) && reasons.length === 0)) return null;
                  return (
                    <div key={layerKey}>
                      <div className="text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-wide mb-0.5">
                        {layerKey.replace(/([A-Z])/g, ' $1').trim()}
                      </div>
                      {Array.isArray(reasons) ? (
                        <ul className="text-xs text-gray-600 dark:text-gray-400 list-disc list-inside space-y-0.5">
                          {reasons.map((r, i) => <li key={i}>{typeof r === 'string' ? r : r.reason || JSON.stringify(r)}</li>)}
                        </ul>
                      ) : (
                        <p className="text-xs text-gray-600 dark:text-gray-400">{JSON.stringify(reasons)}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Override reason if present */}
          {localOverrideReason && (
            <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded px-3 py-2">
              <div className="text-[10px] text-amber-600 dark:text-amber-400 uppercase tracking-wide mb-0.5">Analyst Override Reason</div>
              <p className="text-xs text-amber-800 dark:text-amber-300">{localOverrideReason}</p>
            </div>
          )}
        </div>
      )}

      {/* Override form */}
      {overrideOpen && (
        <div className="mt-3 border-t border-gray-100 dark:border-gray-700 pt-3">
          <div className="bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-lg p-3 space-y-3">
            <div className="flex items-center justify-between">
              <h5 className="text-xs font-semibold text-gray-700 dark:text-gray-300">Analyst Override</h5>
              <button onClick={() => setOverrideOpen(false)} className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-xs">Cancel</button>
            </div>

            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                Score Adjustment ({adjustment > 0 ? '+' : ''}{adjustment})
              </label>
              <input
                type="range" min={-50} max={50} value={adjustment}
                onChange={e => setAdjustment(parseInt(e.target.value))}
                className="w-full h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">
                <span>-50 (lower risk)</span>
                <span className={`font-mono font-bold ${adjustment > 0 ? 'text-red-600 dark:text-red-400' : adjustment < 0 ? 'text-green-600 dark:text-green-400' : 'text-gray-500 dark:text-gray-400'}`}>
                  {adjustment > 0 ? '+' : ''}{adjustment}
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
                onClick={handleSaveOverride}
                disabled={saving || adjustment === 0 || !reason.trim() || reason.trim().length < 3}
                className="px-3 py-1 text-xs font-medium text-white bg-gray-900 dark:bg-gray-600 rounded-lg disabled:opacity-40 hover:bg-gray-800 dark:hover:bg-gray-500"
              >
                {saving ? 'Saving...' : 'Save Override'}
              </button>
              {localOverride != null && (
                <button
                  onClick={handleRemoveOverride} disabled={saving}
                  className="px-3 py-1 text-xs font-medium text-red-700 dark:text-red-400 border border-red-200 dark:border-red-700 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-40"
                >
                  Remove Override
                </button>
              )}
              {adjustment !== 0 && (
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  Effective: {score} {adjustment > 0 ? '+' : ''}{adjustment} = {Math.max(0, Math.min(100, score + adjustment))}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
