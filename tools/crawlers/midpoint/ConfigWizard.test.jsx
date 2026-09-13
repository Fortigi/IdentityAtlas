/**
 * Render smoke test for the midPoint wizard. renderToStaticMarkup never attaches
 * event handlers, so this catches import/relocation mistakes (a bad @ui/ path, a
 * missing shared component) — not interaction bugs.
 */
import { describe, it, expect } from 'vitest';
import ConfigWizard from './ConfigWizard.jsx';
import { makeWizardRenderer } from '../shared/wizardTestKit.js';

const render = makeWizardRenderer(ConfigWizard);
// The two connector-URL opt-in checkboxes (SEC-2026-09 M-03), in render order.
const optInBoxes = (html) => [...html.matchAll(/<input[^>]*name="networkAccess"[^>]*>/g)].map(m => m[0]);

describe('midPoint ConfigWizard render', () => {
  it('renders the add-mode connection step with both network-access opt-ins unticked', () => {
    const html = render();
    expect(html).toContain('Add midPoint Crawler');
    expect(html).toContain('midPoint Base URL');
    expect(html).toContain('Allow private network');
    expect(html).toContain('Allow insecure HTTP');
    const boxes = optInBoxes(html);
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box).not.toContain('checked');
  });

  it('ticks only the opt-in the stored config enables', () => {
    const boxes = optInBoxes(render({
      isEdit: true,
      initialConfig: { id: 3, baseUrl: 'https://idm.corp.local', authMethod: 'BasicAuth', allowPrivateNetwork: true, allowInsecureHttp: false },
    }));
    expect(boxes[0]).toContain('value="allowPrivateNetwork"');
    expect(boxes[0]).toContain('checked');
    expect(boxes[1]).toContain('value="allowInsecureHttp"');
    expect(boxes[1]).not.toContain('checked');
  });
});
