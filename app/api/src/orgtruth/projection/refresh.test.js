import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../contexts/plugins/runner.js', () => ({ enqueueRun: vi.fn(), refreshGeneratedContexts: vi.fn() }));
import { enqueueRun, refreshGeneratedContexts } from '../../contexts/plugins/runner.js';
import { refreshProjections, PROJECTION_PLUGINS, ORG_READING_PLUGINS } from './refresh.js';

beforeEach(() => {
  enqueueRun.mockReset();
  refreshGeneratedContexts.mockReset().mockResolvedValue(0);
});

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

  it('then refreshes the context-assistant users trees, which read org entities, after the projections', async () => {
    enqueueRun.mockResolvedValue({});
    await refreshProjections('org-import');
    expect(refreshGeneratedContexts.mock.calls).toEqual([['org-import', { awaitCompletion: true, algorithms: ['context-recipe-principals'] }]]);
    expect(ORG_READING_PLUGINS).toEqual(['context-recipe-principals']);
    expect(refreshGeneratedContexts.mock.invocationCallOrder[0]).toBeGreaterThan(enqueueRun.mock.invocationCallOrder[1]);
  });

  it('logs a failing plugin and still runs the next one', async () => {
    enqueueRun.mockRejectedValueOnce(new Error('registry locked')).mockResolvedValueOnce({});
    const log = vi.fn();
    await refreshProjections('org-import', log);
    expect(enqueueRun).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('projection org-truth not run: registry locked');
    expect(refreshGeneratedContexts).toHaveBeenCalledTimes(1);
  });

  it('logs a failed recipe refresh instead of failing the import', async () => {
    enqueueRun.mockResolvedValue({});
    refreshGeneratedContexts.mockRejectedValueOnce(new Error('pool closed'));
    const log = vi.fn();
    await expect(refreshProjections('org-import', log)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('context recipes not refreshed: pool closed');
  });
});
