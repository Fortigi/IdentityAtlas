import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import ConfigWizard from './ConfigWizard.jsx';

// renderToStaticMarkup executes the render synchronously, so a missing import
// (e.g. the back-references to app/ui/src/components/ScheduleEditor or
// Stepper) throws here instead of only at runtime in the browser.
describe('Entra ID crawler ConfigWizard', () => {
  const render = (props = {}) =>
    renderToStaticMarkup(h(ConfigWizard, {
      onComplete: () => {},
      onCancel: () => {},
      initialConfig: null,
      isEdit: false,
      authFetch: () => new Promise(() => {}),
      ...props,
    }));

  it('renders step 1 (credentials) without throwing', () => {
    const html = render();
    expect(html).toContain('Add Microsoft Graph Crawler');
    expect(html).toContain('Tenant ID');
    expect(html).toContain('Client Secret');
  });

  it('shows "Edit Microsoft Graph Crawler" in edit mode', () => {
    const html = render({ isEdit: true, initialConfig: { id: 1, displayName: 'Existing', tenantId: 't', clientId: 'c' } });
    expect(html).toContain('Edit Microsoft Graph Crawler');
    expect(html).toContain('leave blank to keep');
  });
});
