import { describe, it, expect } from 'vitest';
import { CAPABILITY_COLUMNS, isOn, needsView, subjectLabel, withCell } from './relativePermissionsGrid.helpers';

describe('relativePermissionsGrid helpers', () => {
  it('names a row group after its template, and business roles as such', () => {
    expect(subjectLabel('OrganizationalUnit')).toBe('Organisation');
    expect(subjectLabel('LogicalApplication')).toBe('Applications');
    expect(subjectLabel('BusinessRole')).toBe('Business roles');
  });

  it('has the four columns in order, and only subUnits and mcp need view', () => {
    expect(CAPABILITY_COLUMNS.map(c => c.key)).toEqual(['view', 'subUnits', 'mcp', 'review']);
    expect(CAPABILITY_COLUMNS.filter(c => needsView(c.key)).map(c => c.key)).toEqual(['subUnits', 'mcp']);
  });

  it('isOn is true only for a literal true', () => {
    expect(isOn({ A: { Accountable: { view: true } } }, 'A', 'Accountable', 'view')).toBe(true);
    expect(isOn({ A: { Accountable: { view: 'true' } } }, 'A', 'Accountable', 'view')).toBe(false);
    expect(isOn(undefined, 'A', 'Accountable', 'view')).toBe(false);
  });

  it('withCell changes one cell and leaves the original alone', () => {
    const before = { A: { Accountable: { view: false, mcp: false }, Responsible: { view: true } }, B: { Accountable: { review: true } } };
    const after = withCell(before, 'A', 'Accountable', 'view', true);
    expect(after.A.Accountable).toEqual({ view: true, mcp: false });
    expect(after.A.Responsible).toBe(before.A.Responsible);
    expect(after.B).toBe(before.B);
    expect(before.A.Accountable.view).toBe(false);
  });

  it('withCell turns the row\'s view-dependent cells off with view, but not review', () => {
    const before = { A: { Accountable: { view: true, subUnits: true, mcp: true } }, B: { Accountable: { view: true, review: true } } };
    expect(withCell(before, 'A', 'Accountable', 'view', false).A.Accountable).toEqual({ view: false, subUnits: false, mcp: false });
    expect(withCell(before, 'B', 'Accountable', 'view', false).B.Accountable).toEqual({ view: false, review: true });
    // turning on an mcp cell does not touch view
    expect(withCell(before, 'A', 'Accountable', 'mcp', false).A.Accountable).toEqual({ view: true, subUnits: true, mcp: false });
  });

  it('withCell fills in a subject or role the grid did not have yet', () => {
    expect(withCell({}, 'C', 'Responsible', 'view', true)).toEqual({ C: { Responsible: { view: true } } });
  });
});
