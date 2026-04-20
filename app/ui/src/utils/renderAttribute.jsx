// Render a single attribute value as a React node. Used by the detail pages
// to make URL-shaped values clickable without forcing the rest of the
// attribute table through a heavy formatter rewrite.
//
// Special cases:
//   - `Link` key → always rendered as a "Open in Entra ID" hyperlink when
//     the value looks like a URL. That's the calculated attribute the Entra
//     crawler stamps on every synced object; we want it discoverable
//     everywhere the value appears.
//   - Any other HTTP(S) URL value → rendered as a generic link showing the
//     URL text. Matches what a user would hope for when seeing a URL in a
//     data table.
//   - Everything else → delegated to `formatValue` for the existing
//     string-rendering rules (date formatting, JSON stringify, etc.).
//
// The extra rendering is pure display — no navigation beyond opening a new
// tab, no state change, no data leakage.

import { formatValue } from './formatters';

const URL_RE = /^https?:\/\//i;

function isHttpUrl(v) {
  return typeof v === 'string' && URL_RE.test(v);
}

export function renderAttributeValue(key, val) {
  // The Link key is the crawler-calculated Entra portal deep link. Show the
  // friendly "Open in Entra ID" label instead of the full URL — URLs are
  // long, noisy, and every reader's eye should just see the action.
  if (key === 'Link' && isHttpUrl(val)) {
    return (
      <a
        href={val}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 hover:underline"
      >
        Open in Entra ID
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      </a>
    );
  }

  // Any other URL-shaped string becomes a clickable link showing the URL
  // text. Useful for future calculated fields (e.g. a link to a wiki page)
  // without each detail page needing to opt in individually.
  if (isHttpUrl(val)) {
    return (
      <a
        href={val}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 hover:text-blue-800 hover:underline break-all"
      >
        {val}
      </a>
    );
  }

  return formatValue(val);
}
