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
import MatrixScopePanel from '@ui/components/matrix/MatrixScopePanel';
import EntityDetailPage from '@ui/components/EntityDetailPage';
import { renderWithProviders, makeAuthFetch, screen, waitFor, cleanup } from '@ui/test-utils/renderWithProviders';

const FILTER = { rowType: 'user', subject: { include: [] }, resource: { include: [] } };
const analyst = { permissions: new Set(['data.read', 'data.export.ui', 'data.share']), hasWildcard: false, permissionsLoaded: true };

function renderShared(ui, { shared, auth = analyst } = {}) {
  return renderWithProviders(h(SharedViewContext.Provider, { value: shared }, ui), { auth, features: { matrixSharing: true } });
}

describe('MatrixToolbar under a shared view', () => {
  const toolbar = (
    <MatrixToolbar managedFilter="all" setManagedFilter={() => {}}
      onExportExcel={() => {}} onShare={() => {}} />
  );

  it('gives an analyst the export and copy-link controls', () => {
    renderShared(toolbar, { shared: false });
    expect(screen.getByRole('button', { name: /Export Excel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy link/i })).toBeInTheDocument();
  });

  // Sharing WITH somebody who has no role is a different act from copying the
  // URL, and since #1202 it has exactly one home — the Load / Save / Share bar.
  // The toolbar must not grow a second control for it.
  it('keeps sharing out of the toolbar — it lives in the save bar', () => {
    renderShared(toolbar, { shared: false });
    expect(screen.queryByRole('button', { name: /Share view/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /link/i }).map(b => b.textContent))
      .toEqual(['Copy link']);
  });

  it('drops both for a share recipient, keeping the governed toggle', () => {
    renderShared(toolbar, { shared: true });
    expect(screen.queryByRole('button', { name: /Export Excel/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy link/i })).not.toBeInTheDocument();
    // Reading controls stay — the recipient can still switch governed/gaps.
    expect(screen.getByRole('button', { name: 'Governed' })).toBeInTheDocument();
  });
});

describe('MatrixFilterSummary under a shared view', () => {
  const summary = <MatrixFilterSummary filter={FILTER} preview={null} onAdjust={() => {}} />;

  it('offers an analyst the Adjust matrix button and the save bar', async () => {
    const authFetch = makeAuthFetch({ '/api/matrix/saved-filters': [] });
    renderShared(summary, { shared: false, auth: { ...analyst, authFetch } });
    expect(screen.getByRole('button', { name: 'Adjust matrix' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Unsaved changes')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Save matrix…' })).toBeInTheDocument();
  });

  it('drops the whole scope strip for a recipient, and skips the fetches behind it', async () => {
    const authFetch = makeAuthFetch({ '/api/matrix/saved-filters': [] });
    const { container } = renderShared(summary, { shared: true, auth: { ...analyst, authFetch } });
    // Not just the Adjust button — the rows/subjects/resources strip and the
    // Load / Save / Share bar go too, so the recipient sees the matrix and
    // nothing around it.
    expect(screen.queryByText('User × Resource')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Adjust matrix' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load matrix/ })).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
    expect(authFetch).not.toHaveBeenCalled();
  });
});

describe('MatrixScopePanel under a shared view', () => {
  const STATS = {
    subjectCount: 1135, resourceCount: 1014, assignmentCount: 2084,
    governedAssignmentCount: 710, ungovernedAssignmentCount: 1374, governedPct: 34.1,
  };
  // A matrix that asked for the panel (#1202) — otherwise it renders nothing
  // for anybody and the shared-view flag would be untested here.
  const panel = <MatrixScopePanel filter={{ ...FILTER, showTrends: true }} />;

  it('shows an analyst the scope statistics', async () => {
    const authFetch = makeAuthFetch({ '/api/matrix/scope-stats': STATS });
    renderShared(panel, { shared: false, auth: { ...analyst, authFetch } });
    // toLocaleString() follows the runner's locale — assert with the same formatter.
    expect(await screen.findByText((1135).toLocaleString())).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Trends & breakdown/i })).toBeInTheDocument();
  });

  it('renders nothing for a recipient and never asks for the stats', async () => {
    cleanup();
    const authFetch = makeAuthFetch({ '/api/matrix/scope-stats': STATS });
    const { container } = renderShared(panel, { shared: true, auth: { ...analyst, authFetch } });
    // The panel debounces its fetch; wait past that before asserting silence.
    await new Promise(r => setTimeout(r, 500));
    expect(container).toBeEmptyDOMElement();
    expect(authFetch).not.toHaveBeenCalled();
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
