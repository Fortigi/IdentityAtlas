// @vitest-environment jsdom
//
// One member's references, as a context owner reads them: grouped, plain text,
// capped with "+ n more", and nothing to click.

import { describe, it, expect } from 'vitest';
import MemberReferences from './MemberReferences';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, within } from '@ui/test-utils/renderWithProviders';

const CTX = 'aaaaaaaa-0000-4000-8000-000000000001';
const MEMBER = 'bbbbbbbb-0000-4000-8000-000000000002';

function mount(answer) {
  const authFetch = makeAuthFetch(() => answer);
  renderWithProviders(<MemberReferences contextId={CTX} memberId={MEMBER} />, { auth: { authFetch } });
  return authFetch;
}

describe('MemberReferences', () => {
  it('reads this member of this context, and shows each group with its total', async () => {
    const authFetch = mount({
      memberType: 'Principal',
      groups: [
        { key: 'resources', total: 1284, items: [{ displayName: 'Finance-Admins', resourceType: 'Group', systemName: 'Entra ID', assignmentType: 'Direct' }] },
        { key: 'businessRoles', total: 0, items: [] },
        { key: 'contexts', total: 1, items: [{ displayName: 'Sales', contextType: 'Department' }] },
      ],
    });
    const resources = await screen.findByRole('region', { name: 'Groups & resources' });
    expect(authFetch.mock.calls[0][0]).toBe(`/api/contexts/${CTX}/members/${MEMBER}/references`);
    expect(within(resources).getByRole('heading')).toHaveTextContent('Groups & resources (1,284)');
    expect(within(resources).getByRole('listitem')).toHaveTextContent('Finance-AdminsGroup · Entra ID · Direct');
    expect(within(resources).getByText('+ 1,283 more')).toBeInTheDocument();

    expect(within(screen.getByRole('region', { name: 'Business roles' })).getByText('None')).toBeInTheDocument();
    const contexts = screen.getByRole('region', { name: 'Other contexts' });
    expect(within(contexts).getByRole('listitem')).toHaveTextContent('SalesDepartment');
    expect(within(contexts).queryByText(/more$/)).toBeNull();

    // Names only: nothing on it opens anything.
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('says so when a member has no reference groups', async () => {
    mount({ memberType: null, groups: [] });
    expect(await screen.findByText('No references.')).toBeInTheDocument();
  });

  it('shows the refusal when the read fails', async () => {
    mount(jsonResponse({ error: 'Context owners can only open their own context' }, { ok: false, status: 403 }));
    expect(await screen.findByRole('alert')).toHaveTextContent('References could not be loaded');
  });
});
