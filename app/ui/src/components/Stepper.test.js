import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import Stepper from './Stepper';

const steps = [
  { n: 1, label: 'One' },
  { n: 2, label: 'Two' },
  { n: 3, label: 'Three' },
];

describe('Stepper', () => {
  it('uses blue for the active step and ✓ + chevrons (no legacy indigo)', () => {
    const html = renderToStaticMarkup(h(Stepper, { steps, current: 2 }));
    expect(html).toContain('bg-blue-600'); // active step — interactive role
    expect(html).not.toContain('indigo'); // legacy colour removed
    expect(html).toContain('✓'); // step 1 is completed
    expect(html).toContain('›'); // chevron separators
  });

  it('hides steps marked shown:false', () => {
    const html = renderToStaticMarkup(
      h(Stepper, { steps: [{ n: 1, label: 'Alpha' }, { n: 2, label: 'Beta', shown: false }, { n: 3, label: 'Gamma' }], current: 1 }),
    );
    expect(html).toContain('Alpha');
    expect(html).not.toContain('Beta');
    expect(html).toContain('Gamma');
  });

  it('renders clickable step buttons only when onStepClick is provided', () => {
    const plain = renderToStaticMarkup(h(Stepper, { steps, current: 1 }));
    expect(plain).not.toContain('<button');
    const clickable = renderToStaticMarkup(h(Stepper, { steps, current: 1, onStepClick: () => {} }));
    expect(clickable).toContain('<button');
    expect(clickable).toContain('Go to step');
  });
});
