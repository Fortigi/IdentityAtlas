import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'ContextDetailPage.jsx'), 'utf8');
// The detail fetch lives in its hook since the page was split below the complexity ceiling.
const hookSrc = readFileSync(join(here, 'contexts', 'useContextDetail.js'), 'utf8');

describe('ContextDetailPage', () => {
  it('has loading + error state', () => {
    // loading/error are reducer-backed (set-state-in-effect cleanup, #417).
    expect(hookSrc).toContain('const [loading, setLoading] = useReducer((_, v) => v, true);');
    expect(hookSrc).toContain('const [error, setError] = useReducer((_, v) => v, null);');
  });

  it('renders a distinct error UI with a retry that re-runs the fetch', () => {
    expect(src).toContain('Failed to load context');
    expect(src).toContain('onRetry={fetchDetail}');
  });

  it('handles the not-found / empty case', () => {
    expect(src).toContain('Context not found.');
  });

  it('fetches the context detail through the auth-wrapped client', () => {
    expect(src).toContain('useAuth()');
    expect(hookSrc).toContain('/api/contexts/${contextId}');
  });

  it('gates member editing to manual/generated contexts', () => {
    expect(src).toContain('canEditMembers');
  });
});
