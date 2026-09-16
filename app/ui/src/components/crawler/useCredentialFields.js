import { useState } from 'react';

// ─── useCredentialFields ─────────────────────────────────────────────────
// The state counterpart to CredentialFields: one object holding every
// credential a REST crawler wizard might collect, plus a per-field setter.
//
// Secrets (password, clientSecret, apiToken, cookieString) always start BLANK,
// including in edit mode, because a blank one means "keep what is in the
// vault" — the stored value is never sent to the browser. Non-secret fields
// seed from the saved config so an edit shows what is configured.
//
// This is also the shape @ui/utils/crawlerCredentials takes, so a wizard can
// pass the result straight to canSubmitCredentials / buildCredentialFields.
export default function useCredentialFields(initialConfig) {
  const [creds, setCreds] = useState({
    username: initialConfig?.username || '',
    password: '',
    apiToken: '',
    clientId: initialConfig?.clientId || '',
    clientSecret: '',
    tokenEndpoint: initialConfig?.tokenEndpoint || '',
    cookieString: '',
  });
  const setCred = (name, value) => setCreds(prev => ({ ...prev, [name]: value }));
  return { creds, setCred };
}
