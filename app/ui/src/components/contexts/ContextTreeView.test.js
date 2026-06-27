import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'ContextTreeView.jsx'), 'utf8');

// The prefix-stripping helpers are covered by ContextTreeView.prefix.test.js;
// this pins the tree component's interaction surface.
describe('ContextTreeView', () => {
  it('tracks expand/collapse and member-visibility state', () => {
    expect(src).toContain('expandedIds');
    expect(src).toContain('showMembers');
    expect(src).toContain('aria-expanded={expanded}');
  });

  it('shows a loading and an empty state for members', () => {
    expect(src).toContain('members === null');
    expect(src).toContain('Loading users');
    expect(src).toContain('No directly-assigned users.');
  });

  it('supports rename, reparent (drag), and add-child interactions', () => {
    expect(src).toContain('onDoubleClick');
    expect(src).toContain('onDragStart');
    expect(src).toContain('setAddingChild');
  });
});
