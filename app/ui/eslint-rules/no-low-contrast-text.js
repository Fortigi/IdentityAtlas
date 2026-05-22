// ESLint rule: no-low-contrast-text
//
// Flags Tailwind text color classes whose light-mode shade (100–400) fails
// WCAG 2.0 AA contrast (≥4.5:1) on white/near-white backgrounds.
//
// Checks className string literals, template literal static parts, and
// conditional expression branches — the three main patterns in this codebase.
// Skips any token prefixed with a Tailwind variant (dark:, hover:, focus:,
// etc.) since those apply only in specific contexts.
//
// Rule: use text-{color}-600 or above for light-mode text; always pair with a
// dark: override. See app/ui/CLAUDE.md § Dark Mode.

// 100–200 are near-white and commonly used on dark/colored button backgrounds
// where contrast is fine — they can't be safely flagged without background context.
// 300 (≈1.5:1) and 400 (≈2.6:1) are the shades that appear as "subtle secondary
// text" on light backgrounds and reliably fail WCAG 2.0 AA.
const FAIL_SHADES = new Set(['300', '400']);

const TAILWIND_COLORS = new Set([
  'gray', 'slate', 'zinc', 'neutral', 'stone',
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald',
  'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple',
  'fuchsia', 'pink', 'rose',
]);

function findBadClasses(str) {
  const bad = [];
  for (const token of str.split(/\s+/)) {
    if (!token) continue;
    if (token.includes(':')) continue; // skip dark:/hover:/focus:/etc. variants
    const m = /^text-([a-z]+)-(\d{3})$/.exec(token);
    if (m && TAILWIND_COLORS.has(m[1]) && FAIL_SHADES.has(m[2])) {
      bad.push(token);
    }
  }
  return bad;
}

function reportBad(node, bad, context) {
  for (const cls of bad) {
    context.report({
      node,
      messageId: 'lowContrast',
      data: { cls },
    });
  }
}

function checkStringValue(node, value, context) {
  reportBad(node, findBadClasses(value), context);
}

// Recursively walks expression nodes that can appear inside className={...}
// to find string literals and template literal static parts.
function walkExpr(node, context) {
  if (!node) return;
  switch (node.type) {
    case 'Literal':
      if (typeof node.value === 'string') checkStringValue(node, node.value, context);
      break;
    case 'TemplateLiteral':
      for (const quasi of node.quasis) {
        checkStringValue(quasi, quasi.value.cooked || '', context);
      }
      for (const expr of node.expressions) {
        walkExpr(expr, context);
      }
      break;
    case 'ConditionalExpression':
      walkExpr(node.consequent, context);
      walkExpr(node.alternate, context);
      break;
    case 'LogicalExpression':
      walkExpr(node.left, context);
      walkExpr(node.right, context);
      break;
    case 'BinaryExpression':
      if (node.operator === '+') {
        walkExpr(node.left, context);
        walkExpr(node.right, context);
      }
      break;
    case 'CallExpression':
      // e.g. clsx('text-gray-400', ...) — check string args
      for (const arg of node.arguments) {
        walkExpr(arg, context);
      }
      break;
    default:
      break;
  }
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow Tailwind text color classes that fail WCAG 2.0 AA contrast (≥4.5:1) on light backgrounds.',
      url: 'app/ui/CLAUDE.md',
    },
    schema: [],
    messages: {
      lowContrast:
        'Text class "{{cls}}" fails WCAG 2.0 AA on light backgrounds. ' +
        'Use -600 or above (e.g. text-gray-600), paired with a dark: variant (e.g. dark:text-gray-400).',
    },
  },

  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name?.name !== 'className') return;
        const val = node.value;
        if (!val) return;

        if (val.type === 'Literal') {
          checkStringValue(val, val.value ?? '', context);
        } else if (val.type === 'JSXExpressionContainer') {
          walkExpr(val.expression, context);
        }
      },
    };
  },
};
