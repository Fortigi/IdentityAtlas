import { useState } from 'react';

// ─── useNetworkAccess ────────────────────────────────────────────────────
// The two connector-URL opt-ins a REST crawler wizard offers (SEC-2026-09 M-03).
// By default the API and the worker only let a crawler send its credential to an
// https URL on a public address:
//
//   allowPrivateNetwork — the server is on a private / on-premises network
//                         (RFC 1918, loopback, IPv6 unique-local). Cloud-metadata
//                         and link-local addresses stay blocked regardless.
//   allowInsecureHttp   — the server only speaks plain http; the credential is
//                         then sent unencrypted.
//
// Both seed from the saved config and are only ever `true` when the config holds
// a literal boolean true — the same rule the API and the worker apply. The
// returned `network` object spreads straight into a config payload.
export default function useNetworkAccess(initialConfig) {
  const [network, setNetwork] = useState({
    allowPrivateNetwork: initialConfig?.allowPrivateNetwork === true,
    allowInsecureHttp: initialConfig?.allowInsecureHttp === true,
  });
  const setNetworkFlag = (name, value) => setNetwork(prev => ({ ...prev, [name]: !!value }));
  return { network, setNetworkFlag };
}
