// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import ComposeFileWarning from './DashboardComposeWarning';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';

describe('ComposeFileWarning', () => {
  it('renders nothing when the version payload is absent', () => {
    const { container } = renderWithProviders(h(ComposeFileWarning, { version: null }));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the compose file is up to date', () => {
    const { container } = renderWithProviders(
      h(ComposeFileWarning, { version: { composeFileOutdated: false } }),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('warns with both the expected and actual compose versions when outdated', () => {
    renderWithProviders(
      h(ComposeFileWarning, {
        version: { composeFileOutdated: true, minComposeFileVersion: '7', composeFileVersion: '4' },
      }),
    );
    expect(screen.getByText(/Your docker-compose file is outdated/i)).toBeInTheDocument();
    expect(screen.getByText(/expects compose file version 7 but your file is version 4/i)).toBeInTheDocument();
  });

  it('falls back to "unknown" when the running file version is missing', () => {
    renderWithProviders(
      h(ComposeFileWarning, {
        version: { composeFileOutdated: true, minComposeFileVersion: '7' },
      }),
    );
    expect(screen.getByText(/but your file is version unknown/i)).toBeInTheDocument();
  });
});
