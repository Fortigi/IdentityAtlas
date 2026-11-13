import { describe, it, expect } from 'vitest';
import {
  CLIENT_SECRET, MANAGED_IDENTITY, credentialConfig, canSubmitCredentials, usesStoredCredentials,
  signInConfig, offersSignInChoice,
} from './signInMethod.js';

const secret = { authMethod: CLIENT_SECRET, tenantId: ' t-1 ', clientId: ' c-1 ', clientSecret: ' s-1 ' };
const managed = { authMethod: MANAGED_IDENTITY, tenantId: ' t-1 ', clientId: ' c-1 ', clientSecret: ' s-1 ' };

describe('credentialConfig (what the discover endpoint is sent)', () => {
  it('sends the trimmed app-registration credentials', () => {
    expect(credentialConfig(secret)).toEqual({ tenantId: 't-1', clientId: 'c-1', clientSecret: 's-1' });
  });

  it('sends nothing but the method for a managed identity — never a secret typed earlier', () => {
    expect(credentialConfig(managed)).toEqual({ authMethod: 'ManagedIdentity' });
  });
});

describe('canSubmitCredentials', () => {
  const filled = { ...secret, crawlerName: 'Prod', isEdit: false };

  it('accepts a complete app registration', () => {
    expect(canSubmitCredentials(filled)).toBe(true);
  });

  it.each(['crawlerName', 'tenantId', 'clientId', 'clientSecret'])('rejects a blank %s on a new crawler', (field) => {
    expect(canSubmitCredentials({ ...filled, [field]: '   ' })).toBe(false);
  });

  it('in edit mode a blank secret is allowed (keep the stored one), a blank client ID is not', () => {
    expect(canSubmitCredentials({ ...filled, isEdit: true, clientSecret: '' })).toBe(true);
    expect(canSubmitCredentials({ ...filled, isEdit: true, clientSecret: '', clientId: '' })).toBe(false);
  });

  it('a managed identity needs only a name', () => {
    const blank = { authMethod: MANAGED_IDENTITY, tenantId: '', clientId: '', clientSecret: '', isEdit: false };
    expect(canSubmitCredentials({ ...blank, crawlerName: 'Prod' })).toBe(true);
    expect(canSubmitCredentials({ ...blank, crawlerName: ' ' })).toBe(false);
  });
});

describe('usesStoredCredentials', () => {
  it('is true only when editing an app-registration crawler without a new secret', () => {
    expect(usesStoredCredentials({ authMethod: CLIENT_SECRET, isEdit: true, clientSecret: ' ' })).toBe(true);
    expect(usesStoredCredentials({ authMethod: CLIENT_SECRET, isEdit: true, clientSecret: 'new' })).toBe(false);
    expect(usesStoredCredentials({ authMethod: CLIENT_SECRET, isEdit: false, clientSecret: '' })).toBe(false);
    expect(usesStoredCredentials({ authMethod: CLIENT_SECRET, isEdit: undefined, clientSecret: '' })).toBe(false);
  });

  it('is never true for a managed identity: it can always be checked live', () => {
    expect(usesStoredCredentials({ authMethod: MANAGED_IDENTITY, isEdit: true, clientSecret: '' })).toBe(false);
  });
});

describe('signInConfig (what a save stores)', () => {
  it('stores the method, tenant and client ID, plus the secret when one was entered', () => {
    expect(signInConfig(secret)).toEqual({ authMethod: 'ClientSecret', tenantId: 't-1', clientId: 'c-1', clientSecret: 's-1' });
  });

  it('leaves the secret out when blank, so the stored one is kept', () => {
    expect(signInConfig({ ...secret, clientSecret: '  ' })).toEqual({ authMethod: 'ClientSecret', tenantId: 't-1', clientId: 'c-1' });
  });

  it('stores no client ID and no secret for a managed identity', () => {
    expect(signInConfig(managed)).toEqual({ authMethod: 'ManagedIdentity', tenantId: 't-1' });
  });
});

describe('offersSignInChoice', () => {
  it('offers the choice where the deployment has a crawler identity', () => {
    expect(offersSignInChoice({ available: true, clientId: 'x' }, CLIENT_SECRET)).toBe(true);
  });

  it('hides it otherwise — also while the answer is still loading', () => {
    expect(offersSignInChoice({ available: false, clientId: null }, CLIENT_SECRET)).toBe(false);
    expect(offersSignInChoice(null, CLIENT_SECRET)).toBe(false);
  });

  it('keeps showing it for a crawler that already uses a managed identity', () => {
    expect(offersSignInChoice({ available: false }, MANAGED_IDENTITY)).toBe(true);
    expect(offersSignInChoice(null, MANAGED_IDENTITY)).toBe(true);
  });
});
