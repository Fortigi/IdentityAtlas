import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'AdminPage.jsx'), 'utf8');

describe('AdminPage', () => {
  it('has loading + error state', () => {
    expect(src).toContain('const [loading, setLoading] = useState(true);');
    expect(src).toContain('const [error, setError] = useState(null);');
  });

  it('renders empty states for each section', () => {
    expect(src).toContain('No risk profile saved yet.');
    expect(src).toContain('No classifiers saved yet.');
    expect(src).toContain('No tokens issued yet.');
  });

  it('fetches the admin sections through the auth-wrapped client', () => {
    expect(src).toContain('useAuth()');
    expect(src).toContain('/api/admin/risk-profile');
    expect(src).toContain('/api/admin/classifiers');
    expect(src).toContain('/api/admin/read-tokens');
  });
});
