export const SECRET_PLACEHOLDER = '••••••••';

// Normalises the raw wizard fields to trimmed strings, defaulting every
// missing key to '' so callers can read any credential field safely.
function normalizeCredentialFields(fields) {
  const {
    username = '', password = '', clientId = '', clientSecret = '',
    tokenEndpoint = '', apiToken = '', cookieString = '',
  } = fields;
  return {
    username: username.trim(),
    password: password.trim(),
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    tokenEndpoint: tokenEndpoint.trim(),
    apiToken: apiToken.trim(),
    cookieString: cookieString.trim(),
  };
}

// Secret fields (password, clientSecret, apiToken, cookieString) may be left
// blank on edit — a blank keeps the stored value — so the "present or editing"
// check relaxes them.
const filledOrEdit = (value, isEdit) => !!(value || isEdit);
const hasUsernamePassword = (f, isEdit) => !!f.username && filledOrEdit(f.password, isEdit);
const hasOAuthClient = (f, isEdit) => !!f.tokenEndpoint && !!f.clientId && filledOrEdit(f.clientSecret, isEdit);

// Each supported auth method has its own set of required credential fields.
const CREDENTIAL_VALIDATORS = {
  FormCookie: hasUsernamePassword,
  BasicAuth: hasUsernamePassword,
  OAuth2CC: hasOAuthClient,
  OAuth2ROPC: (f, isEdit) => hasOAuthClient(f, isEdit) && hasUsernamePassword(f, isEdit),
  ApiToken: (f, isEdit) => filledOrEdit(f.apiToken, isEdit),
  CookieString: (f, isEdit) => filledOrEdit(f.cookieString, isEdit),
};

// Whether the active auth method's required fields are filled in enough to
// submit. isEdit relaxes secret fields (blank = keep stored value). An unknown
// auth method has no gate and is always submittable.
export function canSubmitCredentials(authMethod, fields, isEdit) {
  const validate = CREDENTIAL_VALIDATORS[authMethod];
  return validate ? validate(normalizeCredentialFields(fields), isEdit) : true;
}

// Builds the credential payload from the active auth method's fields.
// Only includes fields that have a value — blank means "keep the existing
// stored value" on edit, and is unreachable on create because
// canSubmitCredentials already requires it there.
export function buildCredentialFields(authMethod, fields) {
  const f = normalizeCredentialFields(fields);
  const out = {};
  if (authMethod === 'FormCookie' || authMethod === 'BasicAuth' || authMethod === 'OAuth2ROPC') {
    out.username = f.username;
    if (f.password) out.password = f.password;
  }
  if (authMethod === 'OAuth2CC' || authMethod === 'OAuth2ROPC') {
    out.tokenEndpoint = f.tokenEndpoint;
    out.clientId = f.clientId;
    if (f.clientSecret) out.clientSecret = f.clientSecret;
  }
  if (authMethod === 'ApiToken' && f.apiToken) out.apiToken = f.apiToken;
  if (authMethod === 'CookieString' && f.cookieString) out.cookieString = f.cookieString;
  return out;
}
