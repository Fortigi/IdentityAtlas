/**
 * Render smoke test for the SQL wizard. renderToStaticMarkup never attaches
 * event handlers, so this catches import/relocation mistakes (a bad @ui/ path, a
 * missing shared component) and the seeding of stored values — not interaction.
 * The Queries step cannot be reached in a static render; QuerySlotEditor.test.jsx
 * covers that step's markup directly.
 */
import { describe, it, expect } from 'vitest';
import ConfigWizard from './ConfigWizard.jsx';
import { makeWizardRenderer } from '../shared/wizardTestKit.js';

const render = makeWizardRenderer(ConfigWizard);
const connectionBoxes = html => [...html.matchAll(/<input[^>]*name="connectionOptions"[^>]*>/g)].map(m => m[0]);

describe('SQL ConfigWizard render', () => {
  it('renders the add-mode connection step', () => {
    const html = render();
    expect(html).toContain('Add SQL Database Crawler');
    expect(html).toContain('Server');
    expect(html).toContain('Database');
    expect(html).toContain('Port');
    expect(html).toContain('value="SQL Database"');
  });

  it('defaults to an encrypted connection without trusting the server certificate', () => {
    const boxes = connectionBoxes(render());
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toContain('value="encrypt"');
    expect(boxes[0]).toContain('checked');
    expect(boxes[1]).toContain('value="trustServerCertificate"');
    expect(boxes[1]).not.toContain('checked');
  });

  it('has no connector-URL opt-ins — a SQL host is not a URL', () => {
    const html = render();
    expect(html).not.toContain('Allow private network');
    expect(html).not.toContain('Allow insecure HTTP');
  });

  it('keeps the advanced settings collapsed by default', () => {
    const html = render();
    expect(html).toContain('Advanced');
    expect(html).not.toContain('Connect timeout');
    expect(html).not.toContain('System name');
  });

  it('edit mode seeds the stored connection values and flags', () => {
    const html = render({
      isEdit: true,
      initialConfig: {
        id: 7, displayName: 'IIQ production', server: 'sql01.corp.local', port: 1533, database: 'identityiq',
        encrypt: false, trustServerCertificate: true, username: 'ia_reader',
        queries: [{ name: 'Identities', target: 'identities', sql: 'SELECT 1' }],
      },
    });
    expect(html).toContain('Edit SQL Database Crawler');
    expect(html).toContain('value="IIQ production"');
    expect(html).toContain('value="sql01.corp.local"');
    expect(html).toContain('value="1533"');
    expect(html).toContain('value="identityiq"');
    const boxes = connectionBoxes(html);
    expect(boxes[0]).not.toContain('checked');
    expect(boxes[1]).toContain('checked');
  });

  it('edit mode without a stored port renders the port field blank', () => {
    const html = render({ isEdit: true, initialConfig: { id: 8, displayName: 'X', server: 'h', database: 'd' } });
    expect(html).toContain('placeholder="1433"');
    expect(html).not.toContain('value="undefined"');
    expect(html).not.toContain('value="null"');
  });
});
