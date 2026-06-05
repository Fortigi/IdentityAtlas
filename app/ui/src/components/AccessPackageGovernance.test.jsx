import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import AccessPackageGovernance from './AccessPackageGovernance';

// renderToStaticMarkup doesn't run effects, so the component renders its
// initial (pre-fetch) state — the three reference sections with a loading
// placeholder. That's enough to assert the governance records are surfaced.
describe('AccessPackageGovernance', () => {
  const html = renderToStaticMarkup(h(AccessPackageGovernance, { accessPackageId: 'ap-1', authFetch: () => Promise.resolve({ ok: true, json: () => [] }) }));

  it('surfaces policies, access reviews and requests as reference sections', () => {
    expect(html).toContain('Assignment Policies');
    expect(html).toContain('Access Reviews');
    expect(html).toContain('Pending Requests');
  });
});
