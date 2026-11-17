import { describe, expect, it } from 'vitest';
import { createGitHubClient } from './github.js';

function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined });
    const next = responses.shift() ?? { ok: true, json: [] };
    return { ok: next.ok ?? true, status: next.status ?? 200, json: async () => next.json, text: async () => next.text ?? '' };
  };
  return { calls, fetchImpl };
}

const page = n => Array.from({ length: n }, (_, i) => ({ number: i }));

describe('createGitHubClient', () => {
  it('needs a token and an owner/name repo', () => {
    expect(() => createGitHubClient({ repo: 'a/b' })).toThrow('A GitHub token is required');
    expect(() => createGitHubClient({ token: 't', repo: 'a' })).toThrow('repo must look like owner/name');
    expect(() => createGitHubClient({ token: 't', repo: 'a/b; rm' })).toThrow('repo must look like owner/name');
  });

  it('lists issues with this review\'s label across pages and stops at a short page', async () => {
    const { calls, fetchImpl } = fakeFetch([{ json: page(100) }, { json: page(3) }]);
    const issues = await createGitHubClient({ token: 'tok', repo: 'o/r', fetchImpl }).listIssues();
    expect(issues).toHaveLength(103);
    expect(calls.map(c => c.url)).toEqual([
      'https://api.github.com/repos/o/r/issues?state=all&labels=ai-security-review&per_page=100&page=1',
      'https://api.github.com/repos/o/r/issues?state=all&labels=ai-security-review&per_page=100&page=2',
    ]);
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
    expect(calls[0].headers['Content-Type']).toBeUndefined();
  });

  it('stops after 20 pages even when every page is full', async () => {
    const { calls, fetchImpl } = fakeFetch(Array.from({ length: 25 }, () => ({ json: page(100) })));
    const advisories = await createGitHubClient({ token: 't', repo: 'o/r', fetchImpl }).listAdvisories();
    expect(calls).toHaveLength(20);
    expect(advisories).toHaveLength(2000);
    expect(calls[0].url).toBe('https://api.github.com/repos/o/r/security-advisories?per_page=100&page=1');
  });

  it('posts new issues and advisories as JSON', async () => {
    const { calls, fetchImpl } = fakeFetch([{ json: { html_url: 'i' } }, { json: { html_url: 'a' } }]);
    const client = createGitHubClient({ token: 't', repo: 'o/r', fetchImpl });
    expect(await client.createIssue({ title: 'T' })).toEqual({ html_url: 'i' });
    expect(await client.createAdvisory({ summary: 'S' })).toEqual({ html_url: 'a' });
    expect(calls.map(c => [c.method, c.url, c.body])).toEqual([
      ['POST', 'https://api.github.com/repos/o/r/issues', { title: 'T' }],
      ['POST', 'https://api.github.com/repos/o/r/security-advisories', { summary: 'S' }],
    ]);
    expect(calls[0].headers['Content-Type']).toBe('application/json');
  });

  it('fails with the status and response text when GitHub refuses', async () => {
    const { fetchImpl } = fakeFetch([{ ok: false, status: 403, text: 'Resource not accessible by integration' }]);
    const client = createGitHubClient({ token: 't', repo: 'o/r', fetchImpl });
    await expect(client.createAdvisory({})).rejects.toThrow('GitHub POST /repos/o/r/security-advisories failed: 403 Resource not accessible by integration');
  });

  it('offers addToBoard only when a project is configured', async () => {
    expect(createGitHubClient({ token: 't', repo: 'o/r', fetchImpl: fakeFetch([]).fetchImpl }).addToBoard).toBeUndefined();
    const { calls, fetchImpl } = fakeFetch([{ json: { data: {} } }]);
    await createGitHubClient({ token: 't', repo: 'o/r', projectId: 'PVT_1', fetchImpl }).addToBoard('I_5');
    expect(calls[0].url).toBe('https://api.github.com/graphql');
    expect(calls[0].body.variables).toEqual({ p: 'PVT_1', c: 'I_5' });
  });

  it('fails when the board mutation returns GraphQL errors', async () => {
    const { fetchImpl } = fakeFetch([{ json: { errors: [{ message: 'no access' }] } }]);
    const client = createGitHubClient({ token: 't', repo: 'o/r', projectId: 'PVT_1', fetchImpl });
    await expect(client.addToBoard('I_5')).rejects.toThrow('Adding to the board failed: no access');
  });
});
