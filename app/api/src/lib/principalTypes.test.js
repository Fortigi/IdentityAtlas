import { describe, it, expect } from 'vitest';
import { GROUP_PRINCIPAL_TYPE } from './principalTypes.js';

describe('GROUP_PRINCIPAL_TYPE', () => {
  it('is the Microsoft Graph group @odata.type', () => {
    // Pinned: this exact value is interpolated into matrix/permission SQL to
    // exclude groups from "who has access" counts. Changing it silently changes
    // that SQL, so lock it here.
    expect(GROUP_PRINCIPAL_TYPE).toBe('#microsoft.graph.group');
  });
});
