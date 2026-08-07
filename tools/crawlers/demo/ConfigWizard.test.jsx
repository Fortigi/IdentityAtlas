import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import ConfigWizard, { buildDemoJobPayload } from './ConfigWizard.jsx';

describe('Demo crawler ConfigWizard', () => {
  const render = (props = {}) =>
    renderToStaticMarkup(h(ConfigWizard, {
      onComplete: () => {},
      onCancel: () => {},
      authFetch: () => new Promise(() => {}),
      ...props,
    }));

  it('renders the info page without throwing', () => {
    const html = render();
    expect(html).toContain('Load Demo Data');
    expect(html).toContain('What gets imported');
  });

  it('includes a cancel button', () => {
    const html = render();
    expect(html).toContain('Cancel');
  });

  it('offers the high-cardinality volume slice as a labelled, unchecked option', () => {
    const html = render();
    expect(html).toContain('Also load high-cardinality test data');
    expect(html).toContain('id="demo-include-volume"');
    expect(html).toContain('for="demo-include-volume"');
    expect(html).not.toContain('checked=""');
  });
});

describe('buildDemoJobPayload', () => {
  it('omits the config entirely for an ordinary demo import', () => {
    // The default import must stay exactly what it always was — the small
    // 39-resource company the CTF answers and the E2E suite assume.
    expect(buildDemoJobPayload(false)).toEqual({ jobType: 'demo' });
  });

  it('asks for the volume slice when the option is ticked', () => {
    expect(buildDemoJobPayload(true)).toEqual({
      jobType: 'demo',
      config: { includeVolumeData: true },
    });
  });
});
