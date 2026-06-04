// Real JWT validation test.
//
// Unlike the matrix/round-trip tests (which mock jwt.verify), this runs the
// REAL jsonwebtoken verification path in authMiddleware against tokens we mint
// with a self-signed RSA key. A fake JWKS provider (via authConfig.getJwksClient)
// hands the middleware our public key, so signature/audience/issuer/expiry/
// algorithm/tenant enforcement is all exercised for real — no Entra tenant.

import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken'; // REAL — not mocked here
import request from 'supertest';

const TENANT = '00000000-0000-0000-0000-000000000000';
const CLIENT = '11111111-1111-1111-1111-111111111111';
const KID = 'test-key-1';

// Holder the hoisted authConfig mock can read once we've generated the keypair.
const keys = vi.hoisted(() => ({ publicKeyPem: '' }));

vi.mock('../config/authConfig.js', () => ({
  isAuthEnabled: () => true,
  // Fake JWKS: hand the middleware our test public key for any kid.
  getJwksClient: () => ({
    getSigningKey: (_kid, cb) => cb(null, { getPublicKey: () => keys.publicKeyPem }),
  }),
  getTenantId: () => TENANT,
  getClientId: () => CLIENT,
  getRequiredRoles: () => null,
  getRolePermissions: () => ({ Admin: ['*'] }),
  hasCustomRolePermissions: () => false,
  setRolePermissions: async () => ({}),
  loadAuthConfig: async () => {},
  reloadAuthConfig: async () => {},
  getAuthState: () => ({ enabled: true }),
}));

vi.mock('../db/connection.js', () => {
  const empty = { rows: [], rowCount: 0, recordset: [] };
  const poolish = { query: async () => empty, request: () => ({ input() { return this; }, query: async () => empty }) };
  return { query: async () => empty, queryOne: async () => null, tx: async (fn) => fn(poolish), getPool: async () => poolish, closePool: async () => {} };
});

// Generate the signing keypair (before any request hits the fake JWKS).
const rsa = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
keys.publicKeyPem = rsa.publicKey;
const PRIVATE = rsa.privateKey;

const { createApp } = await import('../app.js');
const app = createApp();

const GOOD_AUD = `api://${CLIENT}`;
const GOOD_ISS = `https://login.microsoftonline.com/${TENANT}/v2.0`;

function mint({ aud = GOOD_AUD, iss = GOOD_ISS, tid = TENANT, expiresIn = '5m', algorithm = 'RS256', key = PRIVATE } = {}) {
  return jwt.sign({ roles: ['Admin'], tid }, key, { algorithm, keyid: KID, audience: aud, issuer: iss, expiresIn });
}

const callWith = (token) => request(app).get('/api/auth-me').set('Authorization', `Bearer ${token}`);

describe('authMiddleware — real RS256 token validation', () => {
  it('accepts a correctly-signed token with valid aud/iss/tid', async () => {
    const res = await callWith(mint());
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });

  it('rejects the bare clientId audience — id_tokens are not accepted (H-01 fixed)', async () => {
    // An id_token carries aud = bare <clientId>. Only access tokens for the
    // exposed API scope (aud = api://<clientId>) are accepted.
    const res = await callWith(mint({ aud: CLIENT }));
    expect(res.status).toBe(401);
  });

  it('rejects a wrong audience (401)', async () => {
    const res = await callWith(mint({ aud: 'api://some-other-app' }));
    expect(res.status).toBe(401);
  });

  it('rejects a wrong issuer (401)', async () => {
    const res = await callWith(mint({ iss: 'https://login.microsoftonline.com/evil-tenant/v2.0' }));
    expect(res.status).toBe(401);
  });

  it('rejects an expired token (401)', async () => {
    const res = await callWith(mint({ expiresIn: '-10s' }));
    expect(res.status).toBe(401);
  });

  it('rejects a token signed by a different key — tampered/forged (401)', async () => {
    const other = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const res = await callWith(mint({ key: other.privateKey }));
    expect(res.status).toBe(401);
  });

  it('rejects a non-RS256 (HS256) token — no algorithm confusion (401)', async () => {
    const hsToken = jwt.sign({ roles: ['Admin'], tid: TENANT }, 'a-shared-secret', {
      algorithm: 'HS256', keyid: KID, audience: GOOD_AUD, issuer: GOOD_ISS, expiresIn: '5m',
    });
    const res = await callWith(hsToken);
    expect(res.status).toBe(401);
  });

  it('rejects a token from an unexpected tenant (tid mismatch → 401)', async () => {
    const res = await callWith(mint({ tid: '99999999-9999-9999-9999-999999999999' }));
    expect(res.status).toBe(401);
  });

  it('rejects a missing/garbage bearer token (401)', async () => {
    const res = await request(app).get('/api/auth-me').set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
  });
});
