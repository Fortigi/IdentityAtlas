// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import MatrixCell from './MatrixCell';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';

function renderCell(props = {}) {
  const { container } = renderWithProviders(
    h('table', null, h('tbody', null, h('tr', null,
      h(MatrixCell, { cellKey: 'g1|u1', ...props })))),
  );
  return container.querySelector('td');
}

const types = (...t) => new Set(t);

describe('MatrixCell', () => {
  it('renders one badge per membership type and names them in the tooltip', () => {
    const td = renderCell({ membershipTypes: types('Direct', 'Eligible') });
    expect(screen.getByText('D')).toBeInTheDocument();
    expect(screen.getByText('E')).toBeInTheDocument();
    expect(td).toHaveAttribute('title', 'Direct, Eligible');
  });

  it('paints a governed cell in its business role\'s colour and names the role', () => {
    const td = renderCell({
      membershipTypes: types('Direct'), managed: true,
      apColor: '#fde68a', apCount: 1, apNames: ['HR Manager Role'],
    });
    expect(td).toHaveStyle({ backgroundColor: '#fde68a' });
    expect(td.getAttribute('title')).toContain('Managed by: HR Manager Role');
  });

  it('marks a provisioning gap when a role expects a membership the subject lacks', () => {
    const td = renderCell({ provisioningGap: true, gapExpected: 'Direct', apColor: '#fde68a' });
    expect(screen.getByText('!')).toBeInTheDocument();
    expect(td.getAttribute('title')).toContain('Provisioning gap');
  });

  it('counts the roles covering a cell when there is more than one', () => {
    renderCell({ membershipTypes: types('Direct'), managed: true, apCount: 2, apNames: ['A', 'B'] });
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  // Requestor feedback on #370: that count used to be drawn half outside the
  // cell, over the badges of the row above and the column to the right.
  it('keeps the role count inside its own cell, clear of the badge', () => {
    const td = renderCell({ membershipTypes: types('Direct'), managed: true, apCount: 2 });
    const strip = td.querySelector('span.absolute');
    expect(strip).not.toBeNull();
    // The strip has the top of the cell to itself — the padding reserves it.
    expect(td).toHaveStyle({ position: 'relative', padding: '8px 0px 0px' });
    expect(strip.className).not.toMatch(/-(top|right|bottom|left)-/);
    expect(strip).toHaveTextContent('2');
  });

  it('explains inherited access on click', async () => {
    const onExplainInherited = vi.fn();
    renderCell({ membershipTypes: types('Indirect'), onExplainInherited });
    await userEvent.setup().click(screen.getByText('I'));
    expect(onExplainInherited).toHaveBeenCalledWith('g1|u1');
  });

  // Feedback on #370: a folded business role must not swallow the access it
  // does not itself hand out.
  describe('access a folded business role does not grant', () => {
    it('shows the count and explains it, even on an otherwise empty cell', () => {
      const td = renderCell({ extraAccessCount: 4 });
      expect(screen.getByText('4')).toBeInTheDocument();
      expect(td.getAttribute('title')).toContain('4 assignments on the folded resources');
      expect(td).toHaveStyle({ position: 'relative' });
    });

    it('appends the explanation to the cell\'s own tooltip', () => {
      const td = renderCell({ membershipTypes: types('Direct'), extraAccessCount: 1 });
      expect(td.getAttribute('title')).toContain('Direct');
      expect(td.getAttribute('title')).toContain('1 assignment on the folded resources');
    });

    it('renders no marker when there is nothing extra', () => {
      const td = renderCell({ membershipTypes: types('Direct') });
      expect(td.querySelector('.bg-rose-600')).toBeNull();
    });
  });

  // Requestor feedback on #370: over-granting was visible, under-granting was
  // not — and one subject can be short on one resource of a role and over on
  // another, so both must be able to show at once.
  describe('fewer than the business role assigns', () => {
    it('counts it on a folded role\'s cell and explains it', () => {
      const td = renderCell({ missingAccessCount: 2 });
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(td.getAttribute('title')).toContain('2 assignments on the folded resources that this business role assigns');
      expect(td).toHaveStyle({ position: 'relative' });
    });

    it('shows the fewer and the more count side by side on one cell', () => {
      const td = renderCell({ missingAccessCount: 1, extraAccessCount: 3 });
      expect(td.querySelector('.bg-amber-500')).toHaveTextContent('1');
      expect(td.querySelector('.bg-rose-600')).toHaveTextContent('3');
      expect(td.getAttribute('title')).toContain('does not account for');
      expect(td.getAttribute('title')).toContain('but this subject does not have');
    });
  });

  // Requestor feedback on #370: the two SysAdmins who hold SG-VPN-Access
  // without BR-Engineering-Tools showed a plain "D" — the red count the folded
  // role gave them disappeared as soon as the role was unfolded.
  describe('held outside the business role that grants the resource', () => {
    it('keeps the badge and adds the red count next to it', () => {
      const td = renderCell({
        membershipTypes: types('Direct'), heldOutsideCount: 1,
        heldOutsideNames: 'BR-Engineering-Tools',
      });
      expect(screen.getByText('D')).toBeInTheDocument();
      expect(td.querySelector('.bg-rose-600')).toHaveTextContent('1');
      expect(td.getAttribute('title')).toContain('Direct');
      expect(td.getAttribute('title')).toContain('no business role assigns this resource to this subject');
      expect(td.getAttribute('title')).toContain('carries no assignment of it for this subject');
      expect(td.getAttribute('title')).toContain('BR-Engineering-Tools');
    });

    // The granting role IS one of the subject's — what is missing is the role's
    // assignment of this resource, not the role membership (requestor feedback
    // on #370).
    it('says the role is held when the subject holds it, instead of denying it', () => {
      const td = renderCell({
        membershipTypes: types('Direct'), heldOutsideCount: 1,
        heldOutsideNames: 'BR-Engineering-Tools', heldOutsideHoldsRole: true,
      });
      expect(td.getAttribute('title'))
        .toContain('this subject holds a business role that grants this resource');
      expect(td.getAttribute('title')).not.toContain('does not hold');
    });

    it('names all the granting roles when more than one fails to account for it', () => {
      const td = renderCell({
        membershipTypes: types('Direct'), heldOutsideCount: 2, heldOutsideNames: 'BR-A, BR-B',
      });
      expect(td.querySelector('.bg-rose-600')).toHaveTextContent('2');
      expect(td.getAttribute('title')).toContain('granted by 2 business roles (BR-A, BR-B)');
      expect(td.getAttribute('title'))
        .toContain('none of which carries an assignment of it for this subject');
    });

    it('renders no marker on a cell whose access the role does account for', () => {
      const td = renderCell({ membershipTypes: types('Indirect'), managed: true, heldOutsideCount: 0 });
      expect(td.querySelector('.bg-rose-600')).toBeNull();
    });
  });

  describe('more than the business role assigns, on one cell', () => {
    it('marks a standing membership where the role grants eligibility', () => {
      const td = renderCell({ membershipTypes: types('Direct'), managed: true, overGrant: 'Eligible' });
      expect(screen.getByText('+')).toBeInTheDocument();
      expect(td.getAttribute('title')).toContain('More than the business role assigns');
      expect(td.getAttribute('title')).toContain('Eligible');
    });

    it('yields the corner to the folded-role count so the two never overlap', () => {
      const td = renderCell({ membershipTypes: types('Direct'), overGrant: 'Eligible', extraAccessCount: 2 });
      expect(screen.queryByText('+')).toBeNull();
      expect(td.querySelector('.bg-rose-600')).toHaveTextContent('2');
    });
  });
});
