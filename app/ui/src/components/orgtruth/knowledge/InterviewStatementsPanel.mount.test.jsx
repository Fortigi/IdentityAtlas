// @vitest-environment jsdom
//
// "From interviews" on a detail page: fetches only with both flags on, renders
// nothing when the list is empty or fails, and lists text, quote and source.
import { describe, it, expect } from 'vitest';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor } from '@ui/test-utils/renderWithProviders';
import InterviewStatementsPanel from './InterviewStatementsPanel';

const URL = '/api/org-truth/knowledge/statements?targetType=Identity&targetId=i1';
const ON = { orgTruth: true, knowledgeExtraction: true };
const ROWS = [{ id: 'c1', predicate: 'leads', qualifier: null, text: 'Anna leads Harbour', quote: 'I lead the Harbour team', sourceId: 's1', sourceName: 'Intake Anna', observedAt: '2026-10-01T00:00:00Z' }];

function render(answer, features = ON) {
  const authFetch = makeAuthFetch({ '/api/org-truth/knowledge/statements': answer });
  const view = renderWithProviders(<InterviewStatementsPanel targetType="Identity" targetId="i1" />, { auth: { authFetch }, features });
  return { authFetch, ...view };
}

describe('InterviewStatementsPanel', () => {
  it('lists the accepted statements with quote and source', async () => {
    const { authFetch } = render(ROWS);
    expect(await screen.findByText('Anna leads Harbour')).toBeInTheDocument();
    expect(screen.getByText('“I lead the Harbour team”')).toHaveClass('italic');
    expect(screen.getByText(/^Intake Anna · /)).toBeInTheDocument();
    expect(screen.getByText('From interviews')).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledWith(URL);
  });

  it('renders nothing for an empty list', async () => {
    const { authFetch, container } = render([]);
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(URL));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the route refuses', async () => {
    const { authFetch, container } = render(jsonResponse({ error: 'Not found' }, { ok: false, status: 404 }));
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it.each([[{ orgTruth: true }], [{ knowledgeExtraction: true }]])('does not fetch unless both flags are on (%o)', async (features) => {
    const { authFetch, container } = render(ROWS, features);
    await new Promise(r => setTimeout(r, 20));
    expect(authFetch).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });
});
