import { describe, it, expect } from 'vitest';
import { canSubmitCredentials, buildCredentialFields } from './ConfigWizard.jsx';

const blank = { username: '', password: '', clientId: '', clientSecret: '', tokenEndpoint: '', apiToken: '', cookieString: '' };

describe('canSubmitCredentials', () => {
  it('FormCookie requires username + password on create', () => {
    expect(canSubmitCredentials('FormCookie', blank, false)).toBe(false);
    expect(canSubmitCredentials('FormCookie', { ...blank, username: 'svc' }, false)).toBe(false);
    expect(canSubmitCredentials('FormCookie', { ...blank, username: 'svc', password: 'p' }, false)).toBe(true);
  });

  it('FormCookie allows a blank password on edit (keep stored value)', () => {
    expect(canSubmitCredentials('FormCookie', { ...blank, username: 'svc' }, true)).toBe(true);
    expect(canSubmitCredentials('FormCookie', blank, true)).toBe(false); // username is still required
  });

  it('OAuth2CC requires endpoint + clientId + secret on create, secret optional on edit', () => {
    const partial = { ...blank, tokenEndpoint: 'https://t', clientId: 'c' };
    expect(canSubmitCredentials('OAuth2CC', partial, false)).toBe(false);
    expect(canSubmitCredentials('OAuth2CC', { ...partial, clientSecret: 's' }, false)).toBe(true);
    expect(canSubmitCredentials('OAuth2CC', partial, true)).toBe(true);
  });

  it('OAuth2ROPC requires every field on create (endpoint, clientId, secret, username, password)', () => {
    const full = { ...blank, tokenEndpoint: 'https://t', clientId: 'c', clientSecret: 's', username: 'u', password: 'p' };
    expect(canSubmitCredentials('OAuth2ROPC', full, false)).toBe(true);
    for (const key of ['tokenEndpoint', 'clientId', 'clientSecret', 'username', 'password']) {
      expect(canSubmitCredentials('OAuth2ROPC', { ...full, [key]: '' }, false)).toBe(false);
    }
  });

  it('OAuth2ROPC relaxes only the secret fields (clientSecret, password) on edit', () => {
    const noSecrets = { ...blank, tokenEndpoint: 'https://t', clientId: 'c', username: 'u' };
    expect(canSubmitCredentials('OAuth2ROPC', noSecrets, true)).toBe(true);
    expect(canSubmitCredentials('OAuth2ROPC', { ...noSecrets, tokenEndpoint: '' }, true)).toBe(false);
  });

  it('ApiToken requires a token on create, none on edit', () => {
    expect(canSubmitCredentials('ApiToken', blank, false)).toBe(false);
    expect(canSubmitCredentials('ApiToken', { ...blank, apiToken: 't' }, false)).toBe(true);
    expect(canSubmitCredentials('ApiToken', blank, true)).toBe(true);
  });

  it('CookieString requires a cookie on create, none on edit', () => {
    expect(canSubmitCredentials('CookieString', blank, false)).toBe(false);
    expect(canSubmitCredentials('CookieString', { ...blank, cookieString: 'a=b' }, false)).toBe(true);
    expect(canSubmitCredentials('CookieString', blank, true)).toBe(true);
  });

  it('BasicAuth requires username + password on create', () => {
    expect(canSubmitCredentials('BasicAuth', { ...blank, username: 'u' }, false)).toBe(false);
    expect(canSubmitCredentials('BasicAuth', { ...blank, username: 'u', password: 'p' }, false)).toBe(true);
  });
});

describe('buildCredentialFields', () => {
  it('FormCookie: always sends username, only sends password when non-blank', () => {
    expect(buildCredentialFields('FormCookie', { ...blank, username: 'svc' })).toEqual({ username: 'svc' });
    expect(buildCredentialFields('FormCookie', { ...blank, username: 'svc', password: 'p' }))
      .toEqual({ username: 'svc', password: 'p' });
  });

  it('OAuth2CC: always sends endpoint + clientId, only sends secret when non-blank', () => {
    const fields = { ...blank, tokenEndpoint: 'https://t', clientId: 'c' };
    expect(buildCredentialFields('OAuth2CC', fields)).toEqual({ tokenEndpoint: 'https://t', clientId: 'c' });
    expect(buildCredentialFields('OAuth2CC', { ...fields, clientSecret: 's' }))
      .toEqual({ tokenEndpoint: 'https://t', clientId: 'c', clientSecret: 's' });
  });

  it('OAuth2ROPC: merges both the username/password pair and the OAuth2 fields', () => {
    const fields = { ...blank, tokenEndpoint: 'https://t', clientId: 'c', username: 'u' };
    expect(buildCredentialFields('OAuth2ROPC', fields)).toEqual({ tokenEndpoint: 'https://t', clientId: 'c', username: 'u' });
  });

  it('ApiToken: omits the field entirely when blank (never sends an empty string)', () => {
    expect(buildCredentialFields('ApiToken', blank)).toEqual({});
    expect(buildCredentialFields('ApiToken', { ...blank, apiToken: 't' })).toEqual({ apiToken: 't' });
  });

  it('CookieString: omits the field entirely when blank', () => {
    expect(buildCredentialFields('CookieString', blank)).toEqual({});
    expect(buildCredentialFields('CookieString', { ...blank, cookieString: 'a=b' })).toEqual({ cookieString: 'a=b' });
  });

  it('BasicAuth: always sends username, only sends password when non-blank', () => {
    expect(buildCredentialFields('BasicAuth', { ...blank, username: 'u' })).toEqual({ username: 'u' });
  });

  it('only returns fields relevant to the active auth method (no cross-contamination)', () => {
    const everything = { username: 'u', password: 'p', clientId: 'c', clientSecret: 's', tokenEndpoint: 't', apiToken: 'a', cookieString: 'k' };
    expect(buildCredentialFields('ApiToken', everything)).toEqual({ apiToken: 'a' });
    expect(buildCredentialFields('CookieString', everything)).toEqual({ cookieString: 'k' });
  });
});
