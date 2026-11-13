// @vitest-environment jsdom
//
// Organisation knowledge is an experimental feature (Admin → Experimental,
// `orgKnowledge`, off by default). While it is off, the claims provider is not
// there, so every consumer on a unit's page shows nothing — and nothing asks the
// API, which answers 404 on those endpoints anyway.
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import ClaimsProvider from './ClaimsProvider';
import InterviewMentions from './InterviewMentions';
import AddInformation from './AddInformation';
import SourcesSection from './SourcesSection';
import { useContextClaims } from './claimsContext';
import { renderWithProviders, makeAuthFetch, screen, waitFor } from '@ui/test-utils/renderWithProviders';

const CTX = 'c-unit';

// Shows whether a provider is there, so a test can tell "off" from "still loading".
function Probe() {
  const ctx = useContextClaims();
  return h('span', { 'data-testid': 'probe' }, ctx ? `provider for ${ctx.contextId}` : 'no provider');
}

function page(features) {
  const authFetch = makeAuthFetch({ [`/api/contexts/${CTX}/claims`]: { data: [], contradictions: [] }, [`/api/contexts/${CTX}/interviews`]: { data: [] } });
  renderWithProviders(
    h(ClaimsProvider, { contextId: CTX }, h(Probe), h(AddInformation, { contextId: CTX }), h(SourcesSection, { id: 'src', contextId: CTX })),
    { auth: { authFetch }, features },
  );
  return authFetch;
}

describe('organisation knowledge switched off', () => {
  it('the unit page gets no claims: no provider, no Add information, no Sources — and no request', async () => {
    const authFetch = page({});
    expect(screen.getByTestId('probe')).toHaveTextContent('no provider');
    expect(screen.queryByRole('button', { name: /Add information/ })).toBeNull();
    expect(screen.queryByTestId('sources')).toBeNull();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('switched on, the same page reads the claims of the unit', async () => {
    const authFetch = page({ orgKnowledge: true });
    expect(screen.getByTestId('probe')).toHaveTextContent(`provider for ${CTX}`);
    await waitFor(() => expect(authFetch.mock.calls.map(c => c[0])).toContain(`/api/contexts/${CTX}/claims`));
  });

  it('a person page asks nothing about interview mentions', () => {
    const authFetch = makeAuthFetch({});
    renderWithProviders(h(InterviewMentions, { holder: { identityId: 'i-1' } }), { auth: { authFetch } });
    expect(screen.queryByRole('region', { name: 'Mentioned in interviews' })).toBeNull();
    expect(authFetch).not.toHaveBeenCalled();
  });
});
