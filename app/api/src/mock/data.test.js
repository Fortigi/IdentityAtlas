import { describe, it, expect } from 'vitest';
import { permissionAssignments } from './data.js';

// Locks the mock dataset to the current assignment model: membershipType is only
// ever one of the three universal values. The retired types (Owner/Governed/…)
// must never reappear here — the matrix would render a badge that no longer
// exists in real data. Mirrors app/api/src/ingest/assignmentTypes.guard.test.js
// for the mock source, which that guard's crawler scan does not cover.
describe('mock dataset — assignment model', () => {
  it('emits only the three universal membership types', () => {
    const types = [...new Set(permissionAssignments.map((p) => p.membershipType))].sort();
    expect(types).toEqual(['Direct', 'Eligible', 'Indirect']);
  });

  it('has no retired membership type', () => {
    const retired = ['Owner', 'Governed', 'OAuth2Grant', 'AppRole', 'AppRoleViaGroup', 'DirectoryRole', 'DirectoryRoleEligible'];
    const offenders = permissionAssignments.filter((p) => retired.includes(p.membershipType));
    expect(offenders).toEqual([]);
  });
});
