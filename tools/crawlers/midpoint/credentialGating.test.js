import { describe, it, expect } from 'vitest';
import { canSubmitCredentials, buildCredentialFields } from './ConfigWizard.jsx';

const blank = { username: '', password: '', clientId: '', clientSecret: '', tokenEndpoint: '', apiToken: '' };

describe('canSubmitCredentials', () => {
  it('BasicAuth requires username + password on create', () => {
    expect(canSubmitCredentials('BasicAuth', blank, false)).toBe(false);
    expect(canSubmitCredentials('BasicAuth', { ...blank, username: 'administrator' }, false)).toBe(false);
    expect(canSubmitCredentials('BasicAuth', { ...blank, username: 'administrator', password: 'p' }, false)).toBe(true);
  });

  it('BasicAuth allows a blank password on edit (keep stored value)', () => {
    expect(canSubmitCredentials('BasicAuth', { ...blank, username: 'administrator' }, true)).toBe(true);
    expect(canSubmitCredentials('BasicAuth', blank, true)).toBe(false); // username is still required
  });

  it('ApiToken requires a token on create, none on edit', () => {
    expect(canSubmitCredentials('ApiToken', blank, false)).toBe(false);
    expect(canSubmitCredentials('ApiToken', { ...blank, apiToken: 't' }, false)).toBe(true);
    expect(canSubmitCredentials('ApiToken', blank, true)).toBe(true);
  });

  it('OAuth2CC requires endpoint + clientId + secret on create, secret optional on edit', () => {
    const partial = { ...blank, tokenEndpoint: 'https://idp/token', clientId: 'c' };
    expect(canSubmitCredentials('OAuth2CC', partial, false)).toBe(false);
    expect(canSubmitCredentials('OAuth2CC', { ...partial, clientSecret: 's' }, false)).toBe(true);
    expect(canSubmitCredentials('OAuth2CC', partial, true)).toBe(true);
  });

  it('OAuth2ROPC requires every field on create (endpoint, clientId, secret, username, password)', () => {
    const full = { ...blank, tokenEndpoint: 'https://idp/token', clientId: 'c', clientSecret: 's', username: 'u', password: 'p' };
    expect(canSubmitCredentials('OAuth2ROPC', full, false)).toBe(true);
    for (const key of ['tokenEndpoint', 'clientId', 'clientSecret', 'username', 'password']) {
      expect(canSubmitCredentials('OAuth2ROPC', { ...full, [key]: '' }, false)).toBe(false);
    }
  });

  it('OAuth2ROPC relaxes only the secret fields (clientSecret, password) on edit', () => {
    const noSecrets = { ...blank, tokenEndpoint: 'https://idp/token', clientId: 'c', username: 'u' };
    expect(canSubmitCredentials('OAuth2ROPC', noSecrets, true)).toBe(true);
    expect(canSubmitCredentials('OAuth2ROPC', { ...noSecrets, username: '' }, true)).toBe(false);
  });
});

describe('buildCredentialFields', () => {
  it('BasicAuth: always sends username, only sends password when non-blank', () => {
    expect(buildCredentialFields('BasicAuth', { ...blank, username: 'administrator' })).toEqual({ username: 'administrator' });
    expect(buildCredentialFields('BasicAuth', { ...blank, username: 'administrator', password: 'p' }))
      .toEqual({ username: 'administrator', password: 'p' });
  });

  it('ApiToken: omits the field entirely when blank (never sends an empty string)', () => {
    expect(buildCredentialFields('ApiToken', blank)).toEqual({});
    expect(buildCredentialFields('ApiToken', { ...blank, apiToken: 't' })).toEqual({ apiToken: 't' });
  });

  it('OAuth2CC: always sends endpoint + clientId, only sends secret when non-blank', () => {
    const fields = { ...blank, tokenEndpoint: 'https://idp/token', clientId: 'c' };
    expect(buildCredentialFields('OAuth2CC', fields)).toEqual({ tokenEndpoint: 'https://idp/token', clientId: 'c' });
    expect(buildCredentialFields('OAuth2CC', { ...fields, clientSecret: 's' }))
      .toEqual({ tokenEndpoint: 'https://idp/token', clientId: 'c', clientSecret: 's' });
  });

  it('OAuth2ROPC: merges both the username/password pair and the OAuth2 fields', () => {
    const fields = { ...blank, tokenEndpoint: 'https://idp/token', clientId: 'c', username: 'u' };
    expect(buildCredentialFields('OAuth2ROPC', fields)).toEqual({ tokenEndpoint: 'https://idp/token', clientId: 'c', username: 'u' });
  });

  it('only returns fields relevant to the active auth method (no cross-contamination)', () => {
    const everything = { username: 'u', password: 'p', clientId: 'c', clientSecret: 's', tokenEndpoint: 't', apiToken: 'a' };
    expect(buildCredentialFields('ApiToken', everything)).toEqual({ apiToken: 'a' });
    expect(buildCredentialFields('BasicAuth', everything)).toEqual({ username: 'u', password: 'p' });
  });
});
