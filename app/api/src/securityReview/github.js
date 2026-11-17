// Minimal GitHub REST/GraphQL client for filings.js. Only what the monthly
// security review needs: list and create issues and draft security advisories,
// and add an issue to a project board. `fetchImpl` is injectable for tests.

const API = 'https://api.github.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export function createGitHubClient({ token, repo, projectId, fetchImpl = fetch }) {
  if (!token) throw new Error('A GitHub token is required');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('repo must look like owner/name');

  async function call(method, path, body) {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async function listAll(path) {
    const out = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const sep = path.includes('?') ? '&' : '?';
      const batch = await call('GET', `${path}${sep}per_page=${PAGE_SIZE}&page=${page}`);
      out.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return out;
  }

  const client = {
    listIssues: () => listAll(`/repos/${repo}/issues?state=all&labels=ai-security-review`),
    listAdvisories: () => listAll(`/repos/${repo}/security-advisories`),
    createIssue: issue => call('POST', `/repos/${repo}/issues`, issue),
    createAdvisory: adv => call('POST', `/repos/${repo}/security-advisories`, adv),
  };

  if (projectId) {
    client.addToBoard = async contentId => {
      const query = 'mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}';
      const data = await call('POST', '/graphql', { query, variables: { p: projectId, c: contentId } });
      if (data.errors?.length) throw new Error(`Adding to the board failed: ${data.errors[0].message}`);
      return data;
    };
  }
  return client;
}
