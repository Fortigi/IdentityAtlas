import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import MatrixLegend from './MatrixLegend';

// The matrix view (vw_ResourceUserPermissionAssignments) collapses the
// source-attribute assignment types onto how access is HELD: business role /
// OAuth2 grant / direct app role -> Direct, app role via group -> Indirect. So the
// legend must only show the three real badges (D/I/E) — not Owner/Governed/OAuth2/
// AppRole, which never render as badges (ownership is its own GroupOwnership
// resource row; governance is shown by the cell colour instead).
describe('MatrixLegend', () => {
  const html = renderToStaticMarkup(h(MatrixLegend));

  it('lists the three held-access badges with corrected wording', () => {
    expect(html).toContain('Direct membership');
    expect(html).toContain('Indirect (via a nested resource)');
    expect(html).toContain('Eligible — just-in-time access');
  });

  it('does not list retired assignment types (incl. Owner) as badges', () => {
    expect(html).not.toContain('Owner of the resource');
    expect(html).not.toContain('Governed (granted');
    expect(html).not.toContain('App role');
    expect(html).not.toContain('OAuth2 delegated');
  });

  it('still explains the governed-cell colour and provisioning gap', () => {
    expect(html).toContain('governed');
    expect(html).toContain('Provisioning gap');
  });
});
