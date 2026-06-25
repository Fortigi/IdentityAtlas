export const SECRET_PLACEHOLDER = '••••••••';

// Supported auth methods across all OData/REST crawlers.
// Each auth method has a different set of required credential fields.
// isEdit relaxes the requirement for secret fields (blank = keep stored value).
export function canSubmitCredentials(authMethod, fields, isEdit) {
  const {
    username = '', password = '', clientId = '', clientSecret = '',
    tokenEndpoint = '', apiToken = '', cookieString = '',
  } = fields;
  if (authMethod === 'FormCookie' || authMethod === 'BasicAuth')
    return !!username.trim() && !!(password.trim() || isEdit);
  if (authMethod === 'OAuth2CC')
    return !!tokenEndpoint.trim() && !!clientId.trim() && !!(clientSecret.trim() || isEdit);
  if (authMethod === 'OAuth2ROPC')
    return !!tokenEndpoint.trim() && !!clientId.trim() && !!(clientSecret.trim() || isEdit)
      && !!username.trim() && !!(password.trim() || isEdit);
  if (authMethod === 'ApiToken')    return !!(apiToken.trim() || isEdit);
  if (authMethod === 'CookieString') return !!(cookieString.trim() || isEdit);
  return true;
}

// Builds the credential payload from the active auth method's fields.
// Only includes fields that have a value — blank means "keep the existing
// stored value" on edit, and is unreachable on create because
// canSubmitCredentials already requires it there.
export function buildCredentialFields(authMethod, fields) {
  const {
    username = '', password = '', clientId = '', clientSecret = '',
    tokenEndpoint = '', apiToken = '', cookieString = '',
  } = fields;
  const out = {};
  if (authMethod === 'FormCookie' || authMethod === 'BasicAuth' || authMethod === 'OAuth2ROPC') {
    out.username = username.trim();
    if (password.trim()) out.password = password.trim();
  }
  if (authMethod === 'OAuth2CC' || authMethod === 'OAuth2ROPC') {
    out.tokenEndpoint = tokenEndpoint.trim();
    out.clientId = clientId.trim();
    if (clientSecret.trim()) out.clientSecret = clientSecret.trim();
  }
  if (authMethod === 'ApiToken' && apiToken.trim()) out.apiToken = apiToken.trim();
  if (authMethod === 'CookieString' && cookieString.trim()) out.cookieString = cookieString.trim();
  return out;
}
