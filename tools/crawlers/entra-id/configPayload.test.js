import { describe, it, expect } from 'vitest';
import { buildEntraConfigPayload } from './ConfigWizard.jsx';

const base = {
  crawlerName: 'My Tenant',
  organization: 'Contoso',
  tenantId: ' tenant-1 ',
  clientId: ' client-1 ',
  clientSecret: '',
  selectedObjects: { identity: true },
  identityAttrs: [],
  customUserAttrs: [],
  customGroupAttrs: [],
  schedules: [],
  idFilterEnabled: false,
  idFilterAttr: 'employeeId',
  idFilterCondition: 'isNotNull',
  idFilterValue: '',
  signInLogsDays: 7,
  aiNamePatterns: '',
};

describe('buildEntraConfigPayload', () => {
  it('builds a minimal payload, trimming tenantId/clientId', () => {
    const { displayName, configPayload } = buildEntraConfigPayload(base);
    expect(displayName).toBe('My Tenant');
    expect(configPayload).toEqual({
      tenantId: 'tenant-1',
      clientId: 'client-1',
      selectedObjects: { identity: true },
    });
  });

  it('falls back to "Entra ID — <organization>" when the name is blank', () => {
    const { displayName } = buildEntraConfigPayload({ ...base, crawlerName: '  ' });
    expect(displayName).toBe('Entra ID — Contoso');
  });

  it('falls back to "Entra ID — Unnamed" when both name and organization are blank', () => {
    const { displayName } = buildEntraConfigPayload({ ...base, crawlerName: '', organization: null });
    expect(displayName).toBe('Entra ID — Unnamed');
  });

  it('includes clientSecret when non-blank, omits it when blank (edit mode keeps existing)', () => {
    expect(buildEntraConfigPayload({ ...base, clientSecret: ' new-secret ' }).configPayload.clientSecret).toBe('new-secret');
    expect(buildEntraConfigPayload({ ...base, clientSecret: '' }).configPayload).not.toHaveProperty('clientSecret');
    expect(buildEntraConfigPayload({ ...base, clientSecret: '   ' }).configPayload).not.toHaveProperty('clientSecret');
  });

  it('includes identityAttributes/customUserAttributes/customGroupAttributes/schedules only when non-empty', () => {
    const empty = buildEntraConfigPayload(base).configPayload;
    expect(empty).not.toHaveProperty('identityAttributes');
    expect(empty).not.toHaveProperty('customUserAttributes');
    expect(empty).not.toHaveProperty('customGroupAttributes');
    expect(empty).not.toHaveProperty('schedules');

    const filled = buildEntraConfigPayload({
      ...base,
      identityAttrs: ['employeeType'],
      customUserAttrs: ['userType'],
      customGroupAttrs: ['theme'],
      schedules: [{ frequency: 'daily', hour: 2, minute: 0 }],
    }).configPayload;
    expect(filled.identityAttributes).toEqual(['employeeType']);
    expect(filled.customUserAttributes).toEqual(['userType']);
    expect(filled.customGroupAttributes).toEqual(['theme']);
    expect(filled.schedules).toEqual([{ frequency: 'daily', hour: 2, minute: 0 }]);
  });

  describe('identityFilter', () => {
    it('is omitted when idFilterEnabled is false', () => {
      const { configPayload } = buildEntraConfigPayload({ ...base, idFilterEnabled: false });
      expect(configPayload).not.toHaveProperty('identityFilter');
    });

    it('is omitted when selectedObjects.identity is false, even if enabled', () => {
      const { configPayload } = buildEntraConfigPayload({
        ...base, idFilterEnabled: true, selectedObjects: { identity: false },
      });
      expect(configPayload).not.toHaveProperty('identityFilter');
    });

    it('includes only attribute+condition for isNotNull (no value/values)', () => {
      const { configPayload } = buildEntraConfigPayload({
        ...base, idFilterEnabled: true, idFilterAttr: 'employeeId', idFilterCondition: 'isNotNull',
      });
      expect(configPayload.identityFilter).toEqual({ attribute: 'employeeId', condition: 'isNotNull' });
    });

    it('includes a single value for equals/notEquals', () => {
      const equals = buildEntraConfigPayload({
        ...base, idFilterEnabled: true, idFilterCondition: 'equals', idFilterValue: 'true',
      }).configPayload;
      expect(equals.identityFilter).toEqual({ attribute: 'employeeId', condition: 'equals', value: 'true' });

      const notEquals = buildEntraConfigPayload({
        ...base, idFilterEnabled: true, idFilterCondition: 'notEquals', idFilterValue: 'Contractor',
      }).configPayload;
      expect(notEquals.identityFilter).toEqual({ attribute: 'employeeId', condition: 'notEquals', value: 'Contractor' });
    });

    it('splits, trims, and drops blanks for inValues', () => {
      const { configPayload } = buildEntraConfigPayload({
        ...base, idFilterEnabled: true, idFilterCondition: 'inValues', idFilterValue: ' a, b ,, c ',
      });
      expect(configPayload.identityFilter).toEqual({
        attribute: 'employeeId', condition: 'inValues', values: ['a', 'b', 'c'],
      });
    });
  });

  describe('advanced options (regression coverage for the "silently dropped on save" bug)', () => {
    it('omits signInLogsDays at the default value of 7', () => {
      const { configPayload } = buildEntraConfigPayload({ ...base, signInLogsDays: 7 });
      expect(configPayload).not.toHaveProperty('signInLogsDays');
    });

    it('includes signInLogsDays when set to a non-default valid value', () => {
      const { configPayload } = buildEntraConfigPayload({ ...base, signInLogsDays: 14 });
      expect(configPayload.signInLogsDays).toBe(14);
    });

    it('includes signInLogsDays at the boundaries (1 and 30)', () => {
      expect(buildEntraConfigPayload({ ...base, signInLogsDays: 1 }).configPayload.signInLogsDays).toBe(1);
      expect(buildEntraConfigPayload({ ...base, signInLogsDays: 30 }).configPayload.signInLogsDays).toBe(30);
    });

    it('omits signInLogsDays when out of range or non-numeric', () => {
      expect(buildEntraConfigPayload({ ...base, signInLogsDays: 0 }).configPayload).not.toHaveProperty('signInLogsDays');
      expect(buildEntraConfigPayload({ ...base, signInLogsDays: 31 }).configPayload).not.toHaveProperty('signInLogsDays');
      expect(buildEntraConfigPayload({ ...base, signInLogsDays: -5 }).configPayload).not.toHaveProperty('signInLogsDays');
      expect(buildEntraConfigPayload({ ...base, signInLogsDays: 'abc' }).configPayload).not.toHaveProperty('signInLogsDays');
    });

    it('omits aiNamePatterns when blank or whitespace-only', () => {
      expect(buildEntraConfigPayload({ ...base, aiNamePatterns: '' }).configPayload).not.toHaveProperty('aiNamePatterns');
      expect(buildEntraConfigPayload({ ...base, aiNamePatterns: '   \n  \n' }).configPayload).not.toHaveProperty('aiNamePatterns');
    });

    it('includes aiNamePatterns as a trimmed, blank-filtered array', () => {
      const { configPayload } = buildEntraConfigPayload({
        ...base, aiNamePatterns: ' mycustom.*copilot \n\n \\bassistant\\b \n ',
      });
      expect(configPayload.aiNamePatterns).toEqual(['mycustom.*copilot', '\\bassistant\\b']);
    });

    it('includes both signInLogsDays and aiNamePatterns together (the exact regression scenario)', () => {
      const { configPayload } = buildEntraConfigPayload({
        ...base, signInLogsDays: 21, aiNamePatterns: 'mybot\nmyagent',
      });
      expect(configPayload.signInLogsDays).toBe(21);
      expect(configPayload.aiNamePatterns).toEqual(['mybot', 'myagent']);
    });
  });
});
