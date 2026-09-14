// Shared helper for the crawler wizards' render smoke tests.
//
// Each ConfigWizard.test.jsx built the same `render(props)` wrapper over
// renderToStaticMarkup with the same five default props. Nothing about it is
// crawler-specific, so it was pure duplication.
//
// renderToStaticMarkup never attaches event handlers, so these tests catch
// import/relocation mistakes (a bad @ui/ path, a missing shared component) —
// not interaction bugs. Interaction belongs in the crawler's ConfigWizard.e2e.mjs.
import { renderToStaticMarkup } from 'react-dom/server';
import { it, expect } from 'vitest';
import { createElement as h } from 'react';

// Returns a render(props) for one wizard component. `authFetch` deliberately
// returns a promise that never settles: a smoke test must not depend on, or
// wait for, any network round trip the wizard fires on mount.
export function makeWizardRenderer(ConfigWizard, defaults = {}) {
  return (props) => renderToStaticMarkup(h(ConfigWizard, {
    onComplete: () => {},
    onCancel: () => {},
    initialConfig: null,
    isEdit: false,
    authFetch: () => new Promise(() => {}),
    ...defaults,
    ...props,
  }));
}

// The two connector-URL opt-in checkboxes (SEC-2026-09 M-03) every REST crawler
// wizard shows on its connection step, in render order.
function networkAccessBoxes(html) {
  return [...html.matchAll(/<input[^>]*name="networkAccess"[^>]*>/g)].map(m => m[0]);
}

// Registers the render assertions for those opt-ins inside the caller's describe():
// both unticked for a new crawler, and only the stored one ticked on edit. `title`
// and `field` pin that the checkboxes rendered on the wizard's connection step.
export function networkAccessRenderTests(render, { title, field }) {
  it('renders the add-mode connection step with both network-access opt-ins unticked', () => {
    const html = render();
    expect(html).toContain(title);
    expect(html).toContain(field);
    expect(html).toContain('Allow private network');
    expect(html).toContain('Allow insecure HTTP');
    const boxes = networkAccessBoxes(html);
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box).not.toContain('checked');
  });

  it('ticks only the network-access opt-in the stored config enables', () => {
    const boxes = networkAccessBoxes(render({
      isEdit: true,
      initialConfig: { id: 3, baseUrl: 'https://idm.corp.local', authMethod: 'BasicAuth', allowPrivateNetwork: true, allowInsecureHttp: false },
    }));
    expect(boxes[0]).toContain('value="allowPrivateNetwork"');
    expect(boxes[0]).toContain('checked');
    expect(boxes[1]).toContain('value="allowInsecureHttp"');
    expect(boxes[1]).not.toContain('checked');
  });
}
