import { describe, it, expect } from 'vitest';
import { describeCell } from './MatrixCell.helpers';

const set = (...types) => new Set(types);

describe('describeCell — membership tooltips', () => {
  it('lists managing access packages when apNames are present', () => {
    const { title, bgColor } = describeCell({
      hasMembership: true, membershipTypes: set('Direct'), managed: true,
      apColor: '#abcdef', apNames: ['Finance', 'HR'], provisioningGap: false, gapExpected: null,
    });
    expect(title).toBe('Direct\nManaged by: Finance, HR');
    expect(bgColor).toBe('#abcdef');
  });

  it('notes business-role management when managed but no apNames', () => {
    const { title, bgColor } = describeCell({
      hasMembership: true, membershipTypes: set('Direct', 'Indirect'), managed: true,
      apColor: null, apNames: null, provisioningGap: false, gapExpected: null,
    });
    expect(title).toBe('Direct, Indirect (managed by business role)');
    expect(bgColor).toBe('#dbeafe'); // fallback when apColor missing
  });

  it('shows only the types (no background) for an unmanaged cell', () => {
    const { title, bgColor } = describeCell({
      hasMembership: true, membershipTypes: set('Direct'), managed: false,
      apColor: null, apNames: null, provisioningGap: false, gapExpected: null,
    });
    expect(title).toBe('Direct');
    expect(bgColor).toBeUndefined();
  });

  it('appends the provisioning-gap warning with an expected label', () => {
    const { title } = describeCell({
      hasMembership: true, membershipTypes: set('Direct'), managed: true,
      apColor: '#111', apNames: null, provisioningGap: true, gapExpected: 'Direct',
    });
    expect(title).toContain('(managed by business role)');
    expect(title).toContain('Provisioning gap');
    expect(title).toContain('(expects Direct)');
  });

  it('appends the provisioning-gap warning without a label when none is expected', () => {
    const { title } = describeCell({
      hasMembership: true, membershipTypes: set('Direct'), managed: true,
      apColor: '#111', apNames: null, provisioningGap: true, gapExpected: null,
    });
    expect(title).toContain('Provisioning gap');
    expect(title).not.toContain('expects');
  });
});

describe('describeCell — provisioning gap with no membership', () => {
  it('describes the expected membership and managing packages', () => {
    const { title, bgColor } = describeCell({
      hasMembership: false, membershipTypes: null, managed: true,
      apColor: '#222', apNames: ['Finance'], provisioningGap: true, gapExpected: 'Direct',
    });
    expect(title).toContain('business role expects Direct membership but user has none');
    expect(title).toContain('Managed by: Finance');
    expect(bgColor).toBe('#222');
  });

  it('omits the expected label and packages when absent, using the fallback colour', () => {
    const { title, bgColor } = describeCell({
      hasMembership: false, membershipTypes: null, managed: true,
      apColor: null, apNames: [], provisioningGap: true, gapExpected: null,
    });
    expect(title).toContain('business role expects membership but user has none');
    expect(title).not.toContain('Managed by');
    expect(bgColor).toBe('#dbeafe');
  });

  it('returns no title or background for an empty, unmanaged cell', () => {
    const result = describeCell({
      hasMembership: false, membershipTypes: null, managed: false,
      apColor: null, apNames: null, provisioningGap: false, gapExpected: null,
    });
    expect(result).toEqual({ title: undefined, bgColor: undefined });
  });
});
