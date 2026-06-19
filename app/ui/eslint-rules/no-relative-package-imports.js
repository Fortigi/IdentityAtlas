// ESLint rule: no-relative-package-imports
//
// Import statements in app/ui/src/ must use the '@ui/' path alias instead of
// relative traversal ('../../hooks/X', '../auth/X', etc.).  Same-folder
// imports ('./X') are always fine.
//
// Rationale: deep '../../../' chains are fragile — move a file and every
// importer breaks.  '@ui/' paths are stable regardless of directory depth.
// See app/ui/CLAUDE.md → Import path aliases.

export default {
  meta: {
    type: 'suggestion',
    docs: { description: "Use '@ui/' alias instead of relative path traversal out of the current directory." },
    messages: {
      noRelativeTraversal:
        "Use the '@ui/' alias for cross-directory imports (e.g. '@ui/hooks/X' not '../../hooks/X'). " +
        "Same-folder imports ('./X') are fine.",
    },
    schema: [],
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const src = node.source.value;
        if (src.startsWith('..')) {
          context.report({ node, messageId: 'noRelativeTraversal' });
        }
      },
    };
  },
};
