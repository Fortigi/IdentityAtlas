import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import { RollupContentOptions } from './WizardRollupSection';

// renderToStaticMarkup executes the render synchronously, so a missing import
// throws here instead of only at runtime in the browser. The roll-up content
// choices used to be the wizard's own "Content" step; since #1202 they sit
// inside the Layout step's Roll up section, shown once a roll-up is on.
describe('MatrixFilterWizard — roll-up content options', () => {
  const render = (rollupContent, rollupMetric) =>
    renderToStaticMarkup(h(RollupContentOptions, { rollupContent, rollupMetric, onChange: () => {}, onMetricChange: () => {} }));

  it('shows the three content choices, marking the chosen one', () => {
    const html = render('roles-only', 'count');
    expect(html).toContain('Business roles only');
    expect(html).toContain('Resources and business roles');
    expect(html).toContain('Resources only');
    expect(html).toMatch(/aria-pressed="true"[^>]*>(?:(?!<\/button>).)*Business roles only/);
  });

  it('offers the count vs percentage cell-value choice', () => {
    const html = render('resources-and-roles', 'percent');
    expect(html).toContain('Cell value');
    expect(html).toMatch(/aria-pressed="true"[^>]*>(?:(?!<\/button>).)*Percentage \(%\)/);
  });

  it('defaults a missing content and metric to resources-and-roles and count', () => {
    const html = render(undefined, undefined);
    expect(html).toMatch(/aria-pressed="true"[^>]*>(?:(?!<\/button>).)*Resources and business roles/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>(?:(?!<\/button>).)*Count \(#\)/);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
  });
});
