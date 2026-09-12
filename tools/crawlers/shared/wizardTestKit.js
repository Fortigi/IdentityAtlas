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
