import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');

import { queryOne } from '../../db/connection.js';
import { getProfile } from './profileStore.js';

const ID = '6f1c1c2e-8d3b-4a8e-9c1d-2b3c4d5e6f70';

beforeEach(() => { queryOne.mockReset(); });

describe('getProfile', () => {
  it('never queries for a malformed id', async () => {
    expect(await getProfile('x')).toBeNull();
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('returns the version row, or null when unknown', async () => {
    queryOne.mockResolvedValueOnce({ id: ID, version: 3 }).mockResolvedValueOnce(undefined);
    expect(await getProfile(ID)).toEqual({ id: ID, version: 3 });
    expect(queryOne.mock.calls[0][1]).toEqual([ID]);
    expect(await getProfile(ID)).toBeNull();
  });
});
