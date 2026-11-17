// @vitest-environment jsdom
//
// The page a signed-in user without an Identity Atlas role sees (F-01).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderWithProviders, screen, cleanup, fireEvent } from '@ui/test-utils/renderWithProviders';
import NoRolePage from './NoRolePage';

afterEach(() => cleanup());

describe('NoRolePage', () => {
  it('names the signed-in account and says what to ask for', () => {
    renderWithProviders(<NoRolePage />, { auth: { account: { username: 'pat@contoso.com', name: 'Pat' } } });
    expect(screen.getByText('pat@contoso.com')).toBeInTheDocument();
    expect(screen.getByText(/has no role in Identity Atlas/)).toBeInTheDocument();
    expect(screen.getByText(/Admin, RoleMiner or\s+Servicedesk/)).toBeInTheDocument();
  });

  it('still reads when the account has no name', () => {
    renderWithProviders(<NoRolePage />, { auth: { account: null } });
    expect(screen.getByText(/Your account has no role in Identity Atlas/)).toBeInTheDocument();
  });

  it('signs the user out from the button', () => {
    const logout = vi.fn();
    renderWithProviders(<NoRolePage />, { auth: { account: { username: 'pat@contoso.com' }, logout } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(logout).toHaveBeenCalledTimes(1);
  });
});
