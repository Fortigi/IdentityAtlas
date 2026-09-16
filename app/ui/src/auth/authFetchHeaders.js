// Headers every API call from the UI carries.
//
// X-Requested-With: IdentityAtlas marks a request as coming from the app itself.
// A browser cannot attach a custom header to a cross-site request without a
// CORS preflight that only allowed origins pass, so the API accepts it as a
// same-app signal when it guards state-changing requests (SEC-2026-09 H-07).
export const SAME_APP_HEADER = 'X-Requested-With';
export const SAME_APP_HEADER_VALUE = 'IdentityAtlas';

export function buildAuthHeaders(headers, token) {
  const merged = { [SAME_APP_HEADER]: SAME_APP_HEADER_VALUE, ...headers };
  if (token) merged.Authorization = `Bearer ${token}`;
  return merged;
}
