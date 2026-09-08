// @vitest-environment jsdom
//
// The shared-view flag is only worth anything if the components that own an
// analyst-only control actually honour it. These tests mount those components
// on both sides of the flag (#1166, AC7/AC8) — the same render, one boolean
// apart — so a control that silently reappears for a business recipient fails.

import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { SharedViewContext } from './SharedViewContext';
import MatrixToolbar from '@ui/components/matrix/MatrixToolbar';
import MatrixFilterSummary from '@ui/components/matrix/MatrixFilterSummary';
import EntityDetailPage from '@ui/components/EntityDetailPage';
import { renderWithProviders, makeAuthFetch, screen, waitFor, cleanup } from '@ui/test-utils/renderWithProviders';

const FILTER = { rowType: 'user', subject: { include: [] }, resource: { include: [] } };
const analyst = { permissions: new Set(['data.read', 'data.export.ui', 'data.share']), hasWildcard: false, permissionsLoaded: true };

function renderShared(ui, { shared, auth = analyst } = {}) {
  return renderWithProviders(h(SharedViewContext.Provider, { value: shared }, ui), { auth });
}

describe('MatrixToolbar under a shared view', () => {
  const toolbar = (
    <MatrixToolbar managedFilter="all" setManagedFilter={() => {}} filter={FILTER}
      onExportExcel={() => {}} onShare={() => {}} />
  );

  it('gives an analyst the export and share controls', () => {
    renderShared(toolbar, { shared: false });
    expect(screen.getByRole('button', { name: /Export Excel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Share Link/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Share view/i })).toBeInTheDocument();
  });

  it('drops all three for a share recipient, keeping the governed toggle', () => {
    renderShared(toolbar, { shared: true });
    expect(screen.queryByRole('button', { name: /Export Excel/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Share Link/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Share view/i })).not.toBeInTheDocument();
    // Reading controls stay — the recipient can still switch governed/gaps.
    expect(screen.getByRole('button', { name: 'Governed' })).toBeInTheDocument();
  });
});

describe('MatrixFilterSummary under a shared view', () => {
  const summary = <MatrixFilterSummary filter={FILTER} preview={null} onAdjust={() => {}} />;

  it('offers an analyst the Adjust matrix button and the saved badge', async () => {
    const authFetch = makeAuthFetch({ '/api/matrix/saved-filters': [] });
    renderShared(summary, { shared: false, auth: { ...analyst, authFetch } });
    expect(screen.getByRole('button', { name: 'Adjust matrix' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Not saved')).toBeInTheDocument());
  });

  it('shows the recipient the scope but no way to change it, and skips the saved-filter fetch', async () => {
    const authFetch = makeAuthFetch({ '/api/matrix/saved-filters': [] });
    renderShared(summary, { shared: true, auth: { ...analyst, authFetch } });
    expect(screen.queryByRole('button', { name: 'Adjust matrix' })).not.toBeInTheDocument();
    expect(screen.queryByText('Not saved')).not.toBeInTheDocument();
    // The scope itself is still described — that's what they were sent.
    expect(screen.getByText('User × Resource')).toBeInTheDocument();
    expect(authFetch).not.toHaveBeenCalledWith('/api/matrix/saved-filters');
  });
});

describe('EntityDetailPage under a shared view', () => {
  const DATA = { attributes: { displayName: 'Finance Admins', riskScore: 80 } };
  const detail = (
    <EntityDetailPage
      entityKind="resource"
      entityId="grp-1"
      authFetch={makeAuthFetch({})}
      fetchData={async () => DATA}
      getGraphRootExtras={() => ({})}
      graphCenterLabel="Resource"
      getAttributeEntries={() => [['displayName', 'Finance Admins']]}
      getTabs={(_d, entries) => [
        { key: 'attributes', label: 'Attributes', count: entries.length },
        { key: 'relationships', label: 'Relationships' },
        { key: 'timeline', label: 'Timeline' },
        { key: 'risk', label: 'Risk' },
        false,
      ]}
      renderHeader={(d) => <h2>{d.attributes.displayName}</h2>}
      renderRisk={() => <div>risk panel</div>}
      entityLabel="resource"
      onClose={() => {}}
      onOpenDetail={() => {}}
    />
  );

  const tabNames = () => screen.getAllByRole('tab').map(t => t.textContent.replace(/\d+$/, '').trim());

  it('shows an analyst every tab the page declares', async () => {
    renderShared(detail, { shared: false });
    await screen.findByRole('tab', { name: /Attributes/i });
    expect(tabNames()).toEqual(['Attributes', 'Relationships', 'Timeline', 'Risk']);
  });

  it('hides the analyst-only tabs from a share recipient', async () => {
    cleanup();
    renderShared(detail, { shared: true });
    await screen.findByRole('tab', { name: /Attributes/i });
    expect(tabNames()).toEqual(['Attributes', 'Relationships']);
    expect(screen.queryByText('risk panel')).not.toBeInTheDocument();
  });
});
