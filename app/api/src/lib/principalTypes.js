// Microsoft Graph @odata.type for a security / Microsoft 365 group, stored in
// Principals.principalType. A group is a container, not a subject, so the matrix
// and permission rollups exclude it from user-facing "who has access" counts.
// Centralised here (audit Q10) — previously inlined across ~11 SQL files.
export const GROUP_PRINCIPAL_TYPE = '#microsoft.graph.group';
