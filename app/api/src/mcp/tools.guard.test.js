// Guard: every MCP tool decides, explicitly, what it does for a context owner.
//
// A tool is offered to a context owner only when it says owner: 'scoped' — and
// saying so is a promise that the code it calls enforces the owner's scope
// (mcp/ownerScope.js). A tool added without the field is never offered to an
// owner, and this test fails so its author has to decide.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/connection.js');
const { TOOLS, allowedTools, instructionsFor, INSTRUCTIONS } = await import('./server.js');

const ownerUser = { permissions: new Set(), contextOwner: { contexts: [], contextIds: new Set(), rowScope: { contextIds: [] } } };

describe('every MCP tool', () => {
  it.each(TOOLS.map(t => [t.name, t]))('%s declares owner: "scoped" or "refused"', (_name, tool) => {
    expect(['scoped', 'refused']).toContain(tool.owner);
  });
});

describe('allowedTools for a context owner', () => {
  it('offers exactly the tools marked scoped, whatever permissions say', () => {
    const expected = TOOLS.filter(t => t.owner === 'scoped').map(t => t.name);
    expect(allowedTools(ownerUser).map(t => t.name)).toEqual(expected);
  });

  it('never offers a tool that has not decided, or that refuses owners', () => {
    const undecided = { name: 'new_tool', permission: null };
    const refusing = { name: 'admin_tool', permission: null, owner: 'refused' };
    const scoped = { name: 'ok_tool', permission: 'data.read', owner: 'scoped' };
    expect(allowedTools(ownerUser, [undecided, refusing, scoped]).map(t => t.name)).toEqual(['ok_tool']);
    // An analyst is still filtered by permission only.
    expect(allowedTools({ permissions: new Set(['mcp.use']) }, [undecided, refusing, scoped]).map(t => t.name)).toEqual(['new_tool', 'admin_tool']);
  });
});

describe('server instructions', () => {
  it('tell every assistant how to read "scope", and tell an owner\'s assistant whom it acts for', () => {
    expect(INSTRUCTIONS).toContain('scope.restricted');
    expect(instructionsFor({ permissions: new Set(['*']) })).toBe(INSTRUCTIONS);
    expect(instructionsFor(ownerUser)).toContain('You are acting for a context owner');
  });
});
