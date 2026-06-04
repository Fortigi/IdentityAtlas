// ESLint rule: no-native-dialogs
//
// Flags native window.confirm() / alert() / prompt(). They're unstyled, not
// dark-mode aware, block the thread, and aren't testable — use an in-app
// confirm dialog / toast instead. See the UI Style Guide.
//
// Matches bare calls (confirm(...)) and member calls (window.confirm(...),
// globalThis.alert(...)). Pre-existing offenders are downgraded to a warning
// via a file allowlist in eslint.config.js; new code is an error.

const BANNED = new Set(['confirm', 'alert', 'prompt']);

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow native confirm/alert/prompt dialogs; use an in-app dialog or toast.' },
    messages: {
      nativeDialog: "Avoid native {{name}}() — use an in-app dialog/toast (see the UI Style Guide).",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const c = node.callee;
        let name = null;
        if (c.type === 'Identifier' && BANNED.has(c.name)) {
          name = c.name;
        } else if (
          c.type === 'MemberExpression' && !c.computed &&
          c.property.type === 'Identifier' && BANNED.has(c.property.name) &&
          c.object.type === 'Identifier' && (c.object.name === 'window' || c.object.name === 'globalThis')
        ) {
          name = c.property.name;
        }
        if (name) context.report({ node, messageId: 'nativeDialog', data: { name } });
      },
    };
  },
};
