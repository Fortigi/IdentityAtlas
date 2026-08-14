// Pure helpers for MatrixFilterSummary: turning a filter's condition blocks into
// display chips, and collecting the context ids that need name resolution.

// One builder per condition kind. Each returns the chip descriptor the summary
// renders ({ side, label, title }); unknown kinds have no builder and are skipped.
const CHIP_BUILDERS = {
  context(side, c, contextNames) {
    const name = contextNames.get(c.contextId) || c.contextId.slice(0, 8);
    const relation = side === 'exclude' ? 'NOT in' : 'In';
    const descendants = c.includeChildren ? ' (incl. descendants)' : '';
    const suffix = c.includeChildren ? ' +sub' : '';
    return {
      side,
      label: name + suffix,
      title: `${relation} context "${name}"${descendants}`,
    };
  },
  attribute(side, c) {
    const vals = (c.values || []).join(', ');
    const prefix = side === 'exclude' ? 'NOT ' : '';
    return {
      side,
      label: `${c.field}: ${vals}`,
      title: `${prefix}${c.field} in ${vals}`,
    };
  },
};

function buildChip(side, c, contextNames) {
  const builder = CHIP_BUILDERS[c?.kind];
  return builder ? builder(side, c, contextNames) : null;
}

// Flatten a subject/resource block's include + exclude conditions into chips.
export function collectChips(block, contextNames) {
  if (!block) return [];
  const out = [];
  for (const side of ['include', 'exclude']) {
    for (const c of block[side] || []) {
      const chip = buildChip(side, c, contextNames);
      if (chip) out.push(chip);
    }
  }
  return out;
}

// Every distinct context id referenced by the filter's subject/resource blocks.
export function collectContextIds(filter) {
  const ids = new Set();
  for (const block of [filter?.subject, filter?.resource]) {
    if (!block) continue;
    for (const side of [block.include, block.exclude]) {
      for (const c of side || []) {
        if (c?.kind === 'context' && typeof c.contextId === 'string') ids.add(c.contextId);
      }
    }
  }
  return [...ids];
}
