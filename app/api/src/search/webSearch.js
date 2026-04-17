// Lightweight web search helper for dictionary term enrichment.
//
// Only generic search queries go out — never organization-specific data.
// Falls back gracefully when the search is unavailable or times out.
//
// Currently uses the DuckDuckGo Instant Answer API (no key required).
// Set SEARCH_PROVIDER=none to disable web search entirely.

const TIMEOUT_MS = 5000;
const MAX_SNIPPETS = 4;

const DISABLED = process.env.SEARCH_PROVIDER === 'none';

// Search for a term and return an array of text snippets (max MAX_SNIPPETS).
// Never throws — returns [] on any failure so callers can fall back to LLM knowledge.
export async function searchTerm(term) {
  if (DISABLED) return [];

  try {
    const query = encodeURIComponent(`${term} business process meaning authorization`);
    const url = `https://api.duckduckgo.com/?q=${query}&format=json&no_html=1&skip_disambig=1`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) return [];

    const data = await res.json();
    const snippets = [];

    if (data.AbstractText) snippets.push(data.AbstractText);
    if (data.Answer)       snippets.push(data.Answer);

    for (const topic of (data.RelatedTopics || [])) {
      if (snippets.length >= MAX_SNIPPETS) break;
      if (topic.Text) snippets.push(topic.Text);
    }

    return snippets.slice(0, MAX_SNIPPETS);
  } catch {
    return [];
  }
}
