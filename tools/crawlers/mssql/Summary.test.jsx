import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import Summary, { resolveSystemName } from './Summary.jsx';

/**
 * The card's "System:" line has to show the name the *run* will register, not
 * whatever happens to sit in the stored config (#1240).
 */
describe('SQL Summary — system name', () => {
  it('shows an explicit system-name override', () => {
    expect(resolveSystemName({ systemName: 'IdentityIQ' }, { displayName: 'IIQ prod' })).toBe('IdentityIQ');
  });

  it('shows the crawler name when no override is configured', () => {
    expect(resolveSystemName({}, { displayName: 'IIQ prod' })).toBe('IIQ prod');
  });

  it('shows a stored override of exactly "SQL Database" as the crawler name (stale default)', () => {
    expect(resolveSystemName({ systemName: 'SQL Database' }, { displayName: 'IIQ prod' })).toBe('IIQ prod');
    expect(resolveSystemName({ systemName: '  SQL Database  ' }, { displayName: 'IIQ prod' })).toBe('IIQ prod');
  });

  it('keeps an override that merely contains the type default', () => {
    expect(resolveSystemName({ systemName: 'SQL Database (HR)' }, { displayName: 'IIQ prod' })).toBe('SQL Database (HR)');
  });

  it('falls back to the type literal when the crawler has no name either', () => {
    expect(resolveSystemName({ systemName: 'SQL Database' }, { displayName: '   ' })).toBe('SQL Database');
    expect(resolveSystemName({}, null)).toBe('SQL Database');
    expect(resolveSystemName(undefined, undefined)).toBe('SQL Database');
  });
});

describe('SQL Summary render', () => {
  const render = (cfg, config = { displayName: 'IIQ prod' }) => renderToStaticMarkup(h(Summary, { cfg, config }));

  it('shows server:port, database, username, the masked password and the resolved system name', () => {
    const html = render({ server: 'sql01.corp.local', port: 1533, database: 'identityiq', username: 'ia_reader', systemName: 'SQL Database', queries: [] });
    expect(html).toContain('sql01.corp.local:1533');
    expect(html).toContain('identityiq');
    expect(html).toContain('ia_reader');
    expect(html).toContain('••••••••');
    expect(html).toContain('IIQ prod');
    expect(html).not.toContain('SQL Database');
  });

  it('shows the server alone when no port is stored, and a dash when nothing is', () => {
    expect(render({ server: 'sql01' })).toContain('>sql01<');
    expect(render({})).toContain('—');
  });

  it('renders one chip per enabled query as "name → target" and skips disabled ones', () => {
    const html = render({
      server: 'h', database: 'd',
      queries: [
        { name: 'Identities', target: 'identities', sql: 's' },
        { name: 'Role assignments', target: 'assignments', sql: 's', enabled: true },
        { name: 'Old', target: 'relationships', sql: 's', enabled: false },
      ],
    });
    expect(html).toContain('Identities → identities');
    expect(html).toContain('Role assignments → assignments');
    expect(html).not.toContain('Old → relationships');
    expect(html).not.toContain('none enabled');
  });

  it('says so when no query is enabled', () => {
    expect(render({ server: 'h', queries: [{ name: 'Old', target: 'identities', sql: 's', enabled: false }] })).toContain('none enabled');
    expect(render({ server: 'h' })).toContain('none enabled');
  });

  it('does not render the run status — the card shows that generically', () => {
    const html = render({ server: 'h', lastRunAt: '2026-09-25T00:00:00Z', lastRunStatus: 'failed' });
    expect(html).not.toContain('failed');
    expect(html).not.toContain('2026-09-25');
  });
});

/**
 * A slot that renames its columns onto the contract is worth seeing on the card
 * without opening the wizard — it is the thing most likely to be wrong when a
 * run produces no records.
 */
describe('SQL Summary — column mapping marker', () => {
  const render = cfg => renderToStaticMarkup(h(Summary, { cfg, config: { displayName: 'IIQ prod' } }));

  it('marks only the chips of slots that map columns, with the number mapped', () => {
    const html = render({
      server: 'h', database: 'd',
      queries: [
        { name: 'Entitlements', target: 'resources', sql: 's', columnMap: { EntitlementID: 'id', TechnicalApplication: 'displayName' } },
        { name: 'Identities', target: 'identities', sql: 's' },
      ],
    });
    expect(html).toContain('Entitlements → resources');
    expect(html).toContain('+2 mapped');
    expect(html).toContain('Identities → identities');
    expect(html.match(/mapped/g)).toHaveLength(1);
  });

  it('shows no marker for a slot with an empty or missing mapping', () => {
    expect(render({ server: 'h', queries: [{ name: 'Identities', target: 'identities', sql: 's', columnMap: {} }] })).not.toContain('mapped');
    expect(render({ server: 'h', queries: [{ name: 'Identities', target: 'identities', sql: 's' }] })).not.toContain('mapped');
    expect(render({ server: 'h', queries: [{ name: 'Identities', target: 'identities', sql: 's', columnMap: null }] })).not.toContain('mapped');
  });

  it('does not mark a disabled slot, because its chip is not rendered at all', () => {
    const html = render({ server: 'h', queries: [{ name: 'Old', target: 'resources', sql: 's', enabled: false, columnMap: { A: 'id' } }] });
    expect(html).not.toContain('mapped');
    expect(html).toContain('none enabled');
  });
});
