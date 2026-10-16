// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { makeWrapper, makeAuthFetch, jsonResponse } from '@ui/test-utils/renderWithProviders';
import { enrichmentEntries, enrichmentUrl, useOrgEnrichment } from './enrichment';

const DATA = { groups: [
  { source: 'Maten', profileName: 'Expertise list', attributes: { expertises: ['IAM', '', 'Azure'], level: 'Senior', empty: '', none: null } },
  { source: 'Badges', attributes: { level: 'Gold' } },
] };

describe('enrichmentEntries', () => {
  it('makes one namespaced row per attribute, joins multiple values and drops empty ones', () => {
    expect(enrichmentEntries(DATA)).toEqual([
      ['org.Maten.expertises', 'IAM, Azure', { label: 'expertises', source: 'Maten' }],
      ['org.Maten.level', 'Senior', { label: 'level', source: 'Maten' }],
      ['org.Badges.level', 'Gold', { label: 'level', source: 'Badges' }],
    ]);
    expect(enrichmentEntries(null)).toEqual([]);
    expect(enrichmentEntries({ groups: [{ source: 'X' }] })).toEqual([]);
  });

  it('encodes both parts of the url', () => {
    expect(enrichmentUrl('Principal', 'a/b')).toBe('/api/org-truth/enrichment/Principal/a%2Fb');
  });
});

describe('useOrgEnrichment', () => {
  const run = (handler, features, id = 'u1') => {
    const authFetch = makeAuthFetch(handler);
    const { result } = renderHook(() => useOrgEnrichment('Principal', id), { wrapper: makeWrapper({ auth: { authFetch }, features }).wrapper });
    return { authFetch, result };
  };

  it('fetches this object\'s enrichment when the feature is on', async () => {
    const { authFetch, result } = run({ '/api/org-truth/enrichment/Principal/u1': DATA }, { orgTruth: true });
    await waitFor(() => expect(result.current).toHaveLength(3));
    expect(result.current[0][0]).toBe('org.Maten.expertises');
    expect(authFetch).toHaveBeenCalledWith('/api/org-truth/enrichment/Principal/u1');
  });

  it('asks nothing with the feature off', async () => {
    const { authFetch, result } = run({ '/api/org-truth/enrichment': DATA }, { orgTruth: false });
    expect(result.current).toEqual([]);
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('asks nothing without an id', () => {
    const { authFetch } = run({ '/api/org-truth/enrichment': DATA }, { orgTruth: true }, '');
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('shows nothing when the route is missing or not built', async () => {
    for (const status of [404, 501]) {
      const { authFetch, result } = run(() => jsonResponse({ error: 'x' }, { ok: false, status }), { orgTruth: true });
      await waitFor(() => expect(authFetch).toHaveBeenCalled());
      await waitFor(() => expect(result.current).toEqual([]));
    }
  });
});
