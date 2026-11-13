// Guard: the production Compose file lets an operator configure the reverse
// proxy and the public address (security review Nov 2026, F-35, F-08).
//
// The API reads these from its environment, but a variable that Compose does not
// pass never reaches the container. docker-compose.prod.yml once passed none of
// them, so an install behind nginx or Caddy could not tell the API which proxy
// to trust (every user then shares the proxy's rate-limit bucket) and could not
// set PUBLIC_BASE_URL, which the MCP server requires. Nothing fails at runtime;
// the settings are simply ignored. So it is checked here, over the file itself.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { repoRoot } from '../lib/repoRoot.js';

const compose = parse(readFileSync(join(repoRoot(), 'docker-compose.prod.yml'), 'utf8'));
const webEnv = compose.services.web.environment;

const PROXY_SETTINGS = ['PUBLIC_BASE_URL', 'BEHIND_TLS', 'TRUST_PROXY_HOPS', 'TRUST_PROXY', 'ALLOWED_HOSTS'];

describe('docker-compose.prod.yml passes the proxy settings to the web container', () => {
  it.each(PROXY_SETTINGS)('%s comes from .env and is empty by default', (name) => {
    // Empty by default: a direct install on http://<host>:3001 must keep behaving
    // as before, and every one of these treats '' as unset.
    expect(webEnv[name]).toBe(`\${${name}:-}`);
  });

  it('bumps the compose file version past the one that lacked them', () => {
    expect(Number(webEnv.COMPOSE_FILE_VERSION)).toBeGreaterThanOrEqual(5);
  });
});
