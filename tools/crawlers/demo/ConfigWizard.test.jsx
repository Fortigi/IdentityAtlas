import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import ConfigWizard from './ConfigWizard.jsx';

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
});
