// Unit tests for the report generator warm-up started by bootstrapWorker()
// (warmReportGenerators in bootstrap.js).

import { describe, it, expect, vi } from 'vitest';
import { warmReportGenerators, GENERATOR_WARMUPS } from './bootstrap.js';

const loader = (warmAtStartup) => vi.fn(async () => ({ warmAtStartup }));

describe('warmReportGenerators', () => {
  it('warms one assistant at a time: the second starts only after the first finished', async () => {
    const events = [];
    let finishFirst;
    const first = loader(() => new Promise(r => { events.push('first:start'); finishFirst = () => { events.push('first:end'); r(); }; }));
    const second = loader(async () => { events.push('second:start'); });
    const done = warmReportGenerators([first, second], vi.fn());
    await vi.waitFor(() => expect(events).toEqual(['first:start']));
    expect(second).not.toHaveBeenCalled();
    finishFirst();
    await done;
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('a module that fails to load is reported and does not stop the next one', async () => {
    const warn = vi.fn();
    const next = vi.fn(async () => {});
    await warmReportGenerators([async () => { throw new Error('Cannot find module nlreports/service.js'); }, loader(next)], warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Report generator warm-up skipped:', 'Cannot find module nlreports/service.js');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('a warm-up that fails is reported and does not stop the next one', async () => {
    const warn = vi.fn();
    const next = vi.fn(async () => {});
    await warmReportGenerators([loader(async () => { throw new Error('model server unreachable'); }), loader(next)], warn);
    expect(warn).toHaveBeenCalledWith('Report generator warm-up skipped:', 'model server unreachable');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('warms both assistants, each from a module that really exports warmAtStartup', async () => {
    expect(GENERATOR_WARMUPS).toHaveLength(2);
    for (const load of GENERATOR_WARMUPS) {
      expect(typeof (await load()).warmAtStartup).toBe('function');
    }
  });
});
