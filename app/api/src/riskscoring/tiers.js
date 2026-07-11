// Single source of truth for risk-tier cutoffs.
//
// Kept deliberately dependency-free so both the scoring engine (engine.js) and
// the risk-scores override API (routes/riskScores.js) map a numeric score to the
// SAME tier. They previously drifted — the engine used 90/70 for Critical/High
// while the override path used 80/60 — so re-tiering an entity after an analyst
// override could land it on a different tier than the batch run that produced its
// stored RiskScores.riskTier. The persisted riskTier column and the UI badge both
// follow this scale, so it is the canonical one.
export function tierFor(score) {
  if (score >= 90) return 'Critical';
  if (score >= 70) return 'High';
  if (score >= 40) return 'Medium';
  if (score >= 20) return 'Low';
  if (score >= 1)  return 'Minimal';
  return 'None';
}
