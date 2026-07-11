import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// AdminPage.jsx was split into per-section files under ./admin/. Behaviour is
// covered by AdminPage.mount.test.jsx; these cheap source-level assertions now
// scan the section sources to confirm the loading/empty-state/endpoint wiring
// survived the split.
const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8');
const src = [
  'AdminPage.jsx',
  'admin/RiskScoringSection.jsx',
  'admin/PowerQueryExportSection.jsx',
  'admin/CuratedDataSection.jsx',
  'admin/HistoryRetentionSection.jsx',
  'admin/DangerZoneSection.jsx',
  'admin/LLMSettingsSection.jsx',
].map(read).join('\n');

describe('Admin sections', () => {
  it('have loading + error state', () => {
    expect(src).toContain('const [loading, setLoading] = useState(true);');
    expect(src).toContain('const [error, setError] = useState(null);');
  });

  it('render empty states for each section', () => {
    expect(src).toContain('No risk profile saved yet.');
    expect(src).toContain('No classifiers saved yet.');
    expect(src).toContain('No tokens issued yet.');
  });

  it('fetch the admin sections through the auth-wrapped client', () => {
    expect(src).toContain('useAuth()');
    expect(src).toContain('/api/admin/risk-profile');
    expect(src).toContain('/api/admin/classifiers');
    expect(src).toContain('/api/admin/read-tokens');
  });
});
