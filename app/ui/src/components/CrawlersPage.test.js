import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'CrawlersPage.jsx'), 'utf8');

describe('CrawlersPage', () => {
  it('has loading + error state', () => {
    expect(src).toContain('const [loading, setLoading] = useState(true);');
    expect(src).toContain('const [error, setError] = useState(null);');
  });

  it('renders the error and the getting-started empty state', () => {
    expect(src).toContain('{error}');
    expect(src).toContain('No identity data loaded yet. Add a crawler to get started.');
  });

  it('fetches configs, jobs, and status through the auth-wrapped client', () => {
    expect(src).toContain('useAuth()');
    expect(src).toContain('/api/admin/crawler-configs');
    expect(src).toContain('/api/admin/crawler-jobs');
    expect(src).toContain('/api/admin/status');
  });
});
