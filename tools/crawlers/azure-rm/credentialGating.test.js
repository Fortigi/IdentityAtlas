import { describe, it, expect } from 'vitest';
import { canSubmitAzureCredentials, parseSubscriptionIds } from './ConfigWizard.jsx';

const blank = { tenantId: '', clientId: '', clientSecret: '' };

describe('canSubmitAzureCredentials', () => {
  it('requires tenantId + clientId + secret on create', () => {
    expect(canSubmitAzureCredentials(blank, false)).toBe(false);
    expect(canSubmitAzureCredentials({ ...blank, tenantId: 't' }, false)).toBe(false);
    expect(canSubmitAzureCredentials({ ...blank, tenantId: 't', clientId: 'c' }, false)).toBe(false);
    expect(canSubmitAzureCredentials({ tenantId: 't', clientId: 'c', clientSecret: 's' }, false)).toBe(true);
  });

  it('allows a blank secret on edit (keep stored value), but still needs tenantId + clientId', () => {
    expect(canSubmitAzureCredentials({ ...blank, tenantId: 't', clientId: 'c' }, true)).toBe(true);
    expect(canSubmitAzureCredentials({ ...blank, tenantId: 't' }, true)).toBe(false);
    expect(canSubmitAzureCredentials(blank, true)).toBe(false);
  });

  it('treats whitespace-only fields as empty', () => {
    expect(canSubmitAzureCredentials({ tenantId: '  ', clientId: 'c', clientSecret: 's' }, false)).toBe(false);
  });
});

describe('parseSubscriptionIds', () => {
  it('splits on commas, spaces, and newlines, trimming blanks', () => {
    expect(parseSubscriptionIds('a, b ,c')).toEqual(['a', 'b', 'c']);
    expect(parseSubscriptionIds('a\n b\t c')).toEqual(['a', 'b', 'c']);
    expect(parseSubscriptionIds('')).toEqual([]);
    expect(parseSubscriptionIds('  ')).toEqual([]);
    expect(parseSubscriptionIds(undefined)).toEqual([]);
  });
});
