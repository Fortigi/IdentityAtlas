/**
 * Render smoke test for the SCIM wizard. renderToStaticMarkup never attaches
 * event handlers, so this catches import/relocation mistakes (a bad @ui/ path, a
 * missing shared component) — not interaction bugs. Interaction lives in
 * ConfigWizard.e2e.mjs; the branching logic is unit-tested in wizardLogic.test.js.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import ConfigWizard from './ConfigWizard.jsx';

const render = (props) => renderToStaticMarkup(h(ConfigWizard, {
  onComplete: () => {},
  onCancel: () => {},
  initialConfig: null,
  isEdit: false,
  authFetch: () => new Promise(() => {}),
  ...props,
}));

describe('SCIM ConfigWizard render', () => {
  it('renders the add-mode connection step', () => {
    const html = render();
    expect(html).toContain('Add SCIM 2.0 Crawler');
    expect(html).toContain('SCIM Base URL');
    expect(html).toContain('HTTP Basic Auth');
    expect(html).toContain('OAuth2 Client Credentials');
  });

  it('shows all six steps in the stepper', () => {
    const html = render();
    for (const label of ['Connection', 'Credentials', 'Objects', 'Attributes', 'Type mapping', 'Schedule']) {
      expect(html).toContain(label);
    }
  });

  it('renders edit mode with the stored config prefilled', () => {
    const html = render({
      isEdit: true,
      initialConfig: {
        id: 4,
        displayName: 'SAP CIS',
        baseUrl: 'https://cis.example.com/scim/v2',
        authMethod: 'OAuth2CC',
        systemName: 'SAP CIS',
        selectedAttributes: { user: ['department'], group: [] },
      },
    });
    expect(html).toContain('Edit SCIM 2.0 Crawler');
    expect(html).toContain('https://cis.example.com/scim/v2');
    expect(html).toContain('SAP CIS');
  });
});
