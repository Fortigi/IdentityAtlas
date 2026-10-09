import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../contexts/plugins/runner.js', () => ({ enqueueRun: vi.fn() }));
import { enqueueRun } from '../../contexts/plugins/runner.js';
import { refreshProjections, PROJECTION_PLUGINS } from './refresh.js';

beforeEach(() => enqueueRun.mockReset());

describe('refreshProjections', () => {
  it('runs both plugins in order, each awaited, keyed on its own instance', async () => {
    enqueueRun.mockResolvedValue({});
    await refreshProjections('source-delete');
    expect(enqueueRun.mock.calls).toEqual([
      ['org-truth', { instanceKey: 'org-truth' }, 'source-delete', { awaitCompletion: true }],
      ['org-truth-principals', { instanceKey: 'org-truth-principals' }, 'source-delete', { awaitCompletion: true }],
    ]);
    expect(PROJECTION_PLUGINS).toEqual(['org-truth', 'org-truth-principals']);
  });

  it('logs a failing plugin and still runs the next one', async () => {
    enqueueRun.mockRejectedValueOnce(new Error('registry locked')).mockResolvedValueOnce({});
    const log = vi.fn();
    await refreshProjections('org-import', log);
    expect(enqueueRun).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('projection org-truth not run: registry locked');
  });
});
