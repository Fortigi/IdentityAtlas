// The unit report's "Team roles" tab: the team overview's matrix in the workbook
// (business roles down with their type and last review, direct members across,
// a tick where someone holds a role, and each person's ungoverned count), from the same read as the screen
// (contexts/teamOverview.js loadTeamGrid), so the two cannot disagree.

import { loadTeamGrid, MAX_TEAM } from '../contexts/teamOverview.js';

// A role's type is a property of the role, so it is a column, not a mark per person.
const TYPES = {
  Automatic: { value: 'Rule based', tone: 'automatic' },
  Manual: { value: 'Manual', tone: 'manual' },
};
const UNKNOWN_TYPE = { value: 'Unknown', tone: 'unknown' };
const HELD = { value: '✓', tone: 'held' };

export const MATRIX_NOTE = 'Type: Rule based means a rule adds and removes people, so no periodic review of who holds it; '
  + 'Manual means requested and approved, or assigned, and needs a periodic review; Unknown means the source does not say. '
  + 'Review status: the newest review of the role, as on the Business Roles list. ✓: this person holds the role. '
  + 'Ungoverned: access that no business role of this person explains, directly or through a group in one of their roles.';

/** The Review Status words of the Business Roles list, for one role. Pure. */
export function reviewCell(review = {}) {
  const { complianceStatus, daysOverdue, hasReviewConfigured } = review;
  if (complianceStatus === 'Missed') return { value: daysOverdue > 0 ? `Missed (${daysOverdue}d ago)` : 'Missed', tone: 'missed' };
  if (complianceStatus) return { value: complianceStatus };
  return { value: hasReviewConfigured ? 'Pending first review' : 'Not required' };
}

/** The matrix `reports/xlsxMatrix.js` writes. Pure. */
export function teamRoleMatrix(unitName, { people, roles }) {
  return {
    name: 'Team roles',
    title: `Business roles: ${unitName}`,
    note: MATRIX_NOTE,
    corner: 'Business role',
    columns: ['Type', 'Review status', ...people.map(p => p.displayName)],
    rows: roles.map(role => ({
      label: role.displayName,
      cells: [
        TYPES[role.accessModel?.control] || UNKNOWN_TYPE,
        reviewCell(role.review),
        ...people.map(p => (role.holders.includes(p.id) ? HELD : null)),
      ],
    })),
    footer: [{ label: 'Ungoverned permissions', cells: [null, null, ...people.map(p => p.ungoverned)] }],
  };
}

const NONE = Object.freeze({ matrices: [], notices: [] });

/**
 * The tab for one unit's direct members. The members a decision marked former
 * are left out, as on the screen. A failure costs the tab and says so, never the
 * report.
 */
export async function unitRoleMatrices(db, unit, kind, members) {
  const team = members.filter(m => m.id && !m.markedFormer);
  if (team.length === 0) return NONE;
  if (team.length > MAX_TEAM) {
    return { matrices: [], notices: [{ severity: 'info', text: `The Team roles tab is left out: this unit has more than ${MAX_TEAM} members.` }] };
  }
  try {
    const grid = await loadTeamGrid(db, team.map(m => ({ id: m.id, displayName: m.displayName, memberType: kind })));
    return { matrices: [teamRoleMatrix(unit.displayName, grid)], notices: [] };
  } catch (err) {
    console.error('unit report: team roles failed:', err.message);
    return { matrices: [], notices: [{ severity: 'warning', text: 'The Team roles tab could not be built for this download.' }] };
  }
}
