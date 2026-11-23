// The unit report's "Team roles" tab: the team overview's matrix in the workbook
// (business roles down, direct members across, how each role was assigned, and
// each person's ungoverned count), from the same read as the screen
// (contexts/teamOverview.js loadTeamGrid), so the two cannot disagree.

import { loadTeamGrid, MAX_TEAM } from '../contexts/teamOverview.js';

const MARKS = {
  Automatic: { value: 'Automatic', tone: 'automatic' },
  Requested: { value: 'By hand', tone: 'manual' },
};
const NOT_RECORDED = { value: 'Not recorded', tone: 'unknown' };

export const MATRIX_NOTE = 'Automatic: assigned by a rule. By hand: requested and approved, or assigned. '
  + 'Ungoverned: access that no business role of this person explains, directly or through a group in one of their roles.';

/** The matrix `reports/xlsxMatrix.js` writes. Pure. */
export function teamRoleMatrix(unitName, { people, roles }) {
  return {
    name: 'Team roles',
    title: `Business roles: ${unitName}`,
    note: MATRIX_NOTE,
    corner: 'Business role',
    columns: people.map(p => p.displayName),
    rows: roles.map(role => ({
      label: role.displayName,
      cells: people.map(p => (role.holders.includes(p.id) ? (MARKS[role.origins?.[p.id]?.origin] || NOT_RECORDED) : null)),
    })),
    footer: [{ label: 'Ungoverned permissions', cells: people.map(p => p.ungoverned) }],
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
