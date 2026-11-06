import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { contextTypeLiterals, scanContextTypeUsage } from './contextTypeUsage.js';

describe('contextTypeLiterals', () => {
  it('finds SQL comparisons, with their line', () => {
    const text = 'const q = `SELECT 1\n  WHERE "contextType" = \'Tag\'\n  AND "contextType" <> \'TagGroup\'`;';
    expect(contextTypeLiterals(text)).toEqual([{ value: 'Tag', line: 2 }, { value: 'TagGroup', line: 3 }]);
  });

  it('finds JavaScript comparisons, both equality and inequality', () => {
    const text = "if (c.contextType === 'ManagerHierarchy' || d.contextType !== 'Department') {}";
    expect(contextTypeLiterals(text).map(l => l.value)).toEqual(['ManagerHierarchy', 'Department']);
  });

  it('ignores typeof checks, assignments and lower-case strings', () => {
    const text = [
      "if (typeof body.contextType !== 'string') return;",
      "const node = { contextType: 'Department' };",
      "x.contextType = 'Tag';",
      "if (c.contextType === 'tag') {}",
    ].join('\n');
    expect(contextTypeLiterals(text)).toEqual([]);
  });
});

describe('scanContextTypeUsage', () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-usage-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, 'src', 'routes'), { recursive: true });
  mkdirSync(join(root, 'src', '__tests__'), { recursive: true });
  mkdirSync(join(root, 'src', 'node_modules', 'lib'), { recursive: true });
  writeFileSync(join(root, 'src', 'routes', 'tags.js'), "x\nWHERE \"contextType\" = 'Tag'\n");
  writeFileSync(join(root, 'src', 'Page.jsx'), "if (c.contextType === 'Tag') {}\n");
  writeFileSync(join(root, 'src', 'routes', 'tags.test.js'), "WHERE \"contextType\" = 'FromATest'\n");
  writeFileSync(join(root, 'src', '__tests__', 'fixture.js'), "WHERE \"contextType\" = 'FromAFixture'\n");
  writeFileSync(join(root, 'src', 'node_modules', 'lib', 'x.js'), "WHERE \"contextType\" = 'FromADependency'\n");
  writeFileSync(join(root, 'src', 'notes.md'), "WHERE \"contextType\" = 'FromMarkdown'\n");

  it('maps each value to every place it is compared, skipping tests, fixtures, dependencies and non-source files', () => {
    const usage = scanContextTypeUsage(root, ['src']);
    expect([...usage.keys()]).toEqual(['Tag']);
    expect(usage.get('Tag').sort()).toEqual(['src/Page.jsx:1', 'src/routes/tags.js:2']);
  });

  it('scans the real application by default and finds the tags and manager-hierarchy branches', () => {
    const usage = scanContextTypeUsage();
    expect(usage.get('Tag')).toEqual(expect.arrayContaining([expect.stringMatching(/^app\/api\/src\/routes\/tags\/crud\.js:\d+$/)]));
    expect(usage.get('ManagerHierarchy')).toEqual(expect.arrayContaining([expect.stringMatching(/^app\/ui\/src\/components\/ContextsPage\.jsx:\d+$/)]));
  });
});
