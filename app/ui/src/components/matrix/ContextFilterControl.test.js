import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'ContextFilterControl.jsx'), 'utf8');

describe('ContextFilterControl', () => {
  it('supports adding, removing, and toggling include-children on filter chips', () => {
    expect(src).toContain('function add(node)');
    expect(src).toContain('function remove(id)');
    expect(src).toContain('function toggleChildren(id)');
    expect(src).toContain('includeChildren');
  });

  it('resolves a context label through the auth-wrapped client', () => {
    expect(src).toContain('useAuth()');
    expect(src).toContain('/api/contexts/${v.id}');
  });

  it('opens a picker to add a new context filter', () => {
    expect(src).toContain('setPickerOpen');
  });
});
