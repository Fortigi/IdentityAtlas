import { describe, it, expect } from 'vitest';
import { validateContextObjectType } from './ConfigWizard.jsx';

describe('validateContextObjectType', () => {
  it('returns null when $metadata has not been fetched yet (nothing to validate against)', () => {
    expect(validateContextObjectType({ entitySet: 'Orgunit', identityField: 'OUREF' }, null, null)).toBeNull();
  });

  it('returns no errors when entitySet and identityField are both valid', () => {
    const errs = validateContextObjectType(
      { entitySet: 'Orgunit', identityField: 'OUREF' },
      ['Orgunit', 'Country'],
      ['OUREF', 'Username'],
    );
    expect(errs).toEqual([]);
  });

  it('flags an unknown entitySet with no case-insensitive match', () => {
    const errs = validateContextObjectType({ entitySet: 'Building', identityField: '' }, ['Orgunit', 'Country'], []);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/"Building" is not an entity set in \$metadata/);
    expect(errs[0]).not.toMatch(/Did you mean/);
  });

  it('suggests the correct casing for a case-insensitive entitySet match', () => {
    const errs = validateContextObjectType({ entitySet: 'orgunit', identityField: '' }, ['Orgunit', 'Country'], []);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toBe('"orgunit" not found — names are case-sensitive. Did you mean "Orgunit"?');
  });

  it('flags an unknown identityField with no case-insensitive match', () => {
    const errs = validateContextObjectType({ entitySet: '', identityField: 'Department' }, [], ['OUREF', 'Username']);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/"Department" is not a property of the Identity entity type/);
  });

  it('suggests the correct casing for a case-insensitive identityField match', () => {
    const errs = validateContextObjectType({ entitySet: '', identityField: 'ouref' }, [], ['OUREF', 'Username']);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toBe('"ouref" not found — names are case-sensitive. Did you mean "OUREF"?');
  });

  it('skips identityField validation when metaIdentityProps has not been fetched (only entitySet was)', () => {
    const errs = validateContextObjectType({ entitySet: 'Orgunit', identityField: 'AnythingGoes' }, ['Orgunit'], null);
    expect(errs).toEqual([]);
  });

  it('can report both an invalid entitySet and an invalid identityField at once', () => {
    const errs = validateContextObjectType({ entitySet: 'Building', identityField: 'Department' }, ['Orgunit'], ['OUREF']);
    expect(errs).toHaveLength(2);
  });

  it('ignores blank entitySet/identityField (nothing to validate)', () => {
    expect(validateContextObjectType({ entitySet: '', identityField: '' }, ['Orgunit'], ['OUREF'])).toEqual([]);
  });
});
