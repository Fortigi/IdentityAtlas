import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import ConfigWizard from './ConfigWizard.jsx';

// renderToStaticMarkup executes the render synchronously, so a missing import
// (e.g. the back-references to app/ui/src/components/Stepper or
// app/ui/src/hooks/useDocsUrl) throws here instead of only at runtime in the
// browser.
describe('Custom Connector ConfigWizard', () => {
  const render = (props = {}) =>
    renderToStaticMarkup(h(ConfigWizard, {
      onComplete: () => {},
      onCancel: () => {},
      authFetch: () => new Promise(() => {}),
      ...props,
    }));

  it('renders step 1 (register) without throwing', () => {
    const html = render();
    expect(html).toContain('Custom Connector');
    expect(html).toContain('Connector name');
    expect(html).toContain('Register Connector');
  });
});
