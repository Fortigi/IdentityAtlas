// ESLint rule: no-hardcoded-crawler-meta
//
// Flags hardcoded crawler-type metadata objects (matching the CrawlerMeta shape:
// { id: string, name: string, description: string } inside an array) in any file
// outside tools/crawlers/. These definitions must live in the crawler's own
// tools/crawlers/<type>/CrawlerMeta.js so the UI picks them up via import.meta.glob.
//
// See app/ui/CLAUDE.md § Crawler Wizard Plugin System.

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Crawler type metadata must live in tools/crawlers/<type>/CrawlerMeta.js, not in UI components.' },
    messages: {
      hardcoded:
        'Hardcoded crawler type entry detected. Move this to tools/crawlers/{{id}}/CrawlerMeta.js — ' +
        'the UI picks it up automatically via import.meta.glob.',
    },
    schema: [],
  },
  create(context) {
    const filename = (context.filename ?? context.getFilename?.() ?? '').replace(/\\/g, '/');
    if (filename.includes('tools/crawlers/')) return {};

    return {
      ObjectExpression(node) {
        if (node.parent?.type !== 'ArrayExpression') return;

        const props = node.properties.filter(p => p.type === 'Property');
        const propNames = new Set(props.map(p => p.key?.name ?? p.key?.value));
        if (!propNames.has('id') || !propNames.has('name') || !propNames.has('description')) return;

        const idProp = props.find(p => (p.key?.name ?? p.key?.value) === 'id');
        if (idProp?.value?.type !== 'Literal' || typeof idProp.value.value !== 'string') return;
        if (!/^[a-z][a-z0-9-]*$/.test(idProp.value.value)) return;

        context.report({ node, messageId: 'hardcoded', data: { id: idProp.value.value } });
      },
    };
  },
};
