// ESLint rule: no-legacy-jargon
//
// Keeps internal/legacy jargon out of user-facing strings. Operates on string
// literals and JSX text only (code comments are intentionally NOT checked).
// See the UI Style Guide § Terminology.
//
//   SOLL / IST   -> Governed / Non-governed
//   Org Unit(s)  -> Context
//   Start-FGSync -> "Add a crawler in Admin → Crawlers"

const PATTERNS = [
  { re: /\bSOLL\b/, term: 'SOLL', use: 'Governed' },
  { re: /\bIST\b/, term: 'IST', use: 'Non-governed' },
  { re: /\bOrg Units?\b/i, term: 'Org Unit', use: 'Context' },
  { re: /Start-FGSync/, term: 'Start-FGSync', use: 'an in-app crawler' },
];

function check(context, node, text) {
  if (typeof text !== 'string') return;
  for (const { re, term, use } of PATTERNS) {
    if (re.test(text)) {
      context.report({ node, messageId: 'legacyJargon', data: { term, use } });
      break; // one report per node is enough
    }
  }
}

export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'Disallow legacy/internal jargon in user-facing strings.' },
    messages: {
      legacyJargon: 'Avoid "{{term}}" in user-facing text — use "{{use}}" (see the UI Style Guide § Terminology).',
    },
    schema: [],
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(context, node, node.value);
      },
      JSXText(node) {
        check(context, node, node.value);
      },
      TemplateElement(node) {
        check(context, node, node.value?.cooked ?? node.value?.raw);
      },
    };
  },
};
