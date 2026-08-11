// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import AccessPackageGovernance from './AccessPackageGovernance';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';

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

describe('AccessPackageGovernance review instance table (#758)', () => {
  const decision = {
    id: 'd1',
    reviewInstanceId: 'inst-1',
    reviewInstanceStartDateTime: '2026-01-01T00:00:00Z',
    reviewInstanceEndDateTime: '2026-01-08T00:00:00Z',
    reviewInstanceStatus: 'Completed',
    principalDisplayName: 'Alice Engineer',
    decision: 'Approve',
  };

  function makeAuthFetch() {
    return vi.fn((url) => {
      const s = String(url);
      if (s.includes('/reviews')) return Promise.resolve({ ok: true, json: () => Promise.resolve([decision]) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
  }

  it('renders no table while the review instance is collapsed', async () => {
    const { container } = renderWithProviders(h(AccessPackageGovernance, { accessPackageId: 'ap-1', authFetch: makeAuthFetch() }));

    await screen.findByRole('button', { name: /decided/i });
    expect(container.querySelector('table')).toBeNull();
  });

  it('wraps the decisions table in overflow-x-auto once expanded', async () => {
    const { container } = renderWithProviders(h(AccessPackageGovernance, { accessPackageId: 'ap-1', authFetch: makeAuthFetch() }));
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /decided/i }));

    expect(await screen.findByText('Alice Engineer')).toBeInTheDocument();
    const wrapper = container.querySelector('table').closest('.overflow-x-auto');
    expect(wrapper).toBeTruthy();
  });
});
