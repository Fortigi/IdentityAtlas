import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import { Step2Content } from './MatrixFilterWizard';

// renderToStaticMarkup executes the render synchronously, so a missing import
// (e.g. friendlyLabel) throws here instead of only at runtime in the browser.
// This is the regression test for "friendlyLabel is not defined" when advancing
// to the roll-up Content step.
describe('MatrixFilterWizard — roll-up Content step', () => {
  const render = (rollupContent) =>
    renderToStaticMarkup(h(Step2Content, { rollupContent, rollup: 'department', onChange: () => {} }));

  it('renders without throwing and shows the three content choices', () => {
    const html = render('resources-and-roles');
    expect(html).toContain('Business roles only');
    expect(html).toContain('Resources and business roles');
    expect(html).toContain('Resources only');
  });

  it('labels the rolled-up attribute (exercises friendlyLabel)', () => {
    expect(render('resources-and-roles')).toContain('Department');
  });

  it('strips the ext. prefix from extended attributes', () => {
    const html = renderToStaticMarkup(
      h(Step2Content, { rollupContent: 'roles-only', rollup: 'ext.costCenter', onChange: () => {} }),
    );
    expect(html).not.toContain('ext.costCenter');
  });
});
