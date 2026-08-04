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

  it('explains the count a folded business role shows for access it does not grant', () => {
    expect(html).toContain('folded business role');
    expect(html).toContain('outside the role');
  });

  // Feedback on #370: over-granting was explained, under-granting was not, and
  // the two can occur together on one subject.
  it('explains fewer permissions than the role assigns, in both views', () => {
    expect(html).toContain('More than the role assigns');
    expect(html).toContain('the role assigns this subject but they do not have');
    expect(html).toContain('both counts at once');
  });

  it('explains the chip naming the business role a moved row belongs to', () => {
    expect(html).toContain('named on the row itself');
  });
});
