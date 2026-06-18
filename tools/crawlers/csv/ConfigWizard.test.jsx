import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import ConfigWizard from './ConfigWizard.jsx';

// renderToStaticMarkup executes the render synchronously, so a missing import
// (e.g. the back-reference to app/ui/src/components/Stepper, or the csv-slots.json
// import) throws here instead of only at runtime in the browser.
describe('CSV crawler ConfigWizard', () => {
  const render = (props = {}) =>
    renderToStaticMarkup(h(ConfigWizard, {
      onComplete: () => {},
      onCancel: () => {},
      initialConfig: null,
      isEdit: false,
      authFetch: () => new Promise(() => {}),
      ...props,
    }));

  it('renders step 1 (system info) without throwing', () => {
    const html = render();
    expect(html).toContain('Add CSV Crawler');
    expect(html).toContain('Display name');
    expect(html).toContain('CSV delimiter');
  });

  it('shows "Edit CSV Crawler" in edit mode', () => {
    const html = render({ isEdit: true, initialConfig: { id: 1, systemName: 'Existing' } });
    expect(html).toContain('Edit CSV Crawler');
  });
});
