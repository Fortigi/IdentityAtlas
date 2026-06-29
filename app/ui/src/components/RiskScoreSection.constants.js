// Risk field names — excluded from the generic Attributes table on detail pages
// (they're surfaced by the dedicated RiskScoreSection instead). Kept in a
// non-component module so RiskScoreSection.jsx only exports its component
// (Vite fast-refresh requirement).
export const RISK_FIELDS = new Set([
  'riskScore', 'riskTier', 'riskDirectScore', 'riskMembershipScore',
  'riskStructuralScore', 'riskPropagatedScore', 'riskClassifierMatches',
  'riskExplanation', 'riskScoredAt', 'riskOverride', 'riskOverrideReason',
]);
