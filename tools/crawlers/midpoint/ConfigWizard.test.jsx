/**
 * Render smoke test for the midPoint wizard. renderToStaticMarkup never attaches
 * event handlers, so this catches import/relocation mistakes (a bad @ui/ path, a
 * missing shared component) — not interaction bugs.
 */
import { describe } from 'vitest';
import ConfigWizard from './ConfigWizard.jsx';
import { makeWizardRenderer, networkAccessRenderTests } from '../shared/wizardTestKit.js';

describe('midPoint ConfigWizard render', () => {
  networkAccessRenderTests(makeWizardRenderer(ConfigWizard), { title: 'Add midPoint Crawler', field: 'midPoint Base URL' });
});
