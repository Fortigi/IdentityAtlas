// ESLint rule: no-duplicate-dark-color
//
// Flags a className that sets the SAME dark-mode color property twice with two
// plain `dark:` utilities (no state variant). Tailwind emits both rules and the
// later one in its generated CSS wins, so the intended value is silently
// overridden. This is the copy-paste artifact behind the dark-mode audit
// findings, e.g.:
//
//   text-gray-500 dark:text-gray-400 dark:text-gray-500   // → renders gray-500, not 400
//   dark:text-gray-400 ... hover:text-gray-700 dark:text-gray-300  // 2nd should be dark:hover:
//
// Only PLAIN `dark:` color utilities are considered. A stateful variant like
// `dark:hover:text-...` is the CORRECT way to set a dark hover color, so a
// `dark:text-X` + `dark:hover:text-Y` pair is fine and never flagged.
//
// Started as a warning (ratchet): it surfaces the remaining backlog without
// failing CI; promote to 'error' once clean. See app/ui/CLAUDE.md § Dark Mode.

const TAILWIND_COLORS = new Set([
  'gray', 'slate', 'zinc', 'neutral', 'stone',
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald',
  'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple',
  'fuchsia', 'pink', 'rose', 'white', 'black',
]);

// Color-bearing utility namespaces (the part before the color name).
const COLOR_PROPS = new Set([
  'text', 'bg', 'border', 'ring', 'divide', 'placeholder',
  'decoration', 'outline', 'accent', 'caret', 'fill', 'stroke',
  'from', 'via', 'to', 'shadow',
]);

// Matches exactly `dark:<prop>-<color>[-<shade>][/<opacity>]` — NOT `dark:hover:…`.
const DARK_COLOR = /^dark:([a-z]+)-([a-z]+)(?:-\d{1,3})?(?:\/\d{1,3})?$/;

function findDuplicateProps(str) {
  const seen = new Map(); // prop -> first token
  const dupes = [];
  for (const token of str.split(/\s+/)) {
    if (!token.startsWith('dark:')) continue;
    const m = DARK_COLOR.exec(token);
    if (!m) continue;
    const [, prop, color] = m;
    if (!COLOR_PROPS.has(prop) || !TAILWIND_COLORS.has(color)) continue;
    if (seen.has(prop)) dupes.push({ prop, first: seen.get(prop), second: token });
    else seen.set(prop, token);
  }
  return dupes;
}

function checkStringValue(node, value, context) {
  for (const d of findDuplicateProps(value)) {
    context.report({ node, messageId: 'dupDark', data: { prop: d.prop, a: d.first, b: d.second } });
  }
}

// Walks the expression forms that appear inside className={...} in this codebase.
function walkExpr(node, context) {
  if (!node) return;
  switch (node.type) {
    case 'Literal':
      if (typeof node.value === 'string') checkStringValue(node, node.value, context);
      break;
    case 'TemplateLiteral':
      for (const quasi of node.quasis) checkStringValue(quasi, quasi.value.cooked || '', context);
      for (const expr of node.expressions) walkExpr(expr, context);
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
      if (node.operator === '+') { walkExpr(node.left, context); walkExpr(node.right, context); }
      break;
    case 'CallExpression':
      for (const arg of node.arguments) walkExpr(arg, context);
      break;
    default:
      break;
  }
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow two plain dark: utilities setting the same color property in one className (the later silently wins).',
      url: 'app/ui/CLAUDE.md',
    },
    schema: [],
    messages: {
      dupDark:
        'className sets dark: {{prop}} color twice ("{{a}}" and "{{b}}"); the later one silently wins. ' +
        'Remove the redundant one, or make the hover/focus variant explicit (e.g. dark:hover:{{prop}}-...).',
    },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name?.name !== 'className') return;
        const val = node.value;
        if (!val) return;
        if (val.type === 'Literal') checkStringValue(val, val.value ?? '', context);
        else if (val.type === 'JSXExpressionContainer') walkExpr(val.expression, context);
      },
    };
  },
};
