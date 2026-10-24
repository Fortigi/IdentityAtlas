// @vitest-environment jsdom
//
// The schedule editor every crawler wizard uses. The fields it shows depend on
// the frequency, and switching frequency must leave a schedule the scheduler
// can actually fire.
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import ScheduleEditor from './ScheduleEditor';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';

const render = (schedule, onChange = vi.fn()) => {
  renderWithProviders(h(ScheduleEditor, { schedule, onChange, onRemove: vi.fn() }));
  return onChange;
};
const labels = () => screen.getAllByText(/^(Frequency|Every|Hour \(UTC\)|Minute|Day|Mode)$/).map(el => el.textContent);
const selectAfter = (label) => screen.getByText(label).nextElementSibling;

describe('ScheduleEditor', () => {
  it('shows Every instead of hour and minute for an interval schedule', () => {
    render({ frequency: 'interval', intervalMinutes: 10, syncMode: 'delta' });
    expect(labels()).toEqual(['Frequency', 'Every', 'Mode']);
    expect(selectAfter('Every').value).toBe('10');
  });

  it('shows hour, minute and day for a weekly schedule', () => {
    render({ frequency: 'weekly', hour: 3, minute: 0, day: 1 });
    expect(labels()).toEqual(['Frequency', 'Hour (UTC)', 'Minute', 'Day', 'Mode']);
  });

  it('shows only the minute for an hourly schedule', () => {
    render({ frequency: 'hourly', minute: 30 });
    expect(labels()).toEqual(['Frequency', 'Minute', 'Mode']);
  });

  it('switching to every few minutes yields a schedule with an interval', async () => {
    const onChange = render({ frequency: 'daily', hour: 2, minute: 0, syncMode: 'delta' });
    await userEvent.selectOptions(selectAfter('Frequency'), 'interval');
    expect(onChange).toHaveBeenCalledWith({ frequency: 'interval', hour: 2, minute: 0, syncMode: 'delta', intervalMinutes: 15 });
  });

  it('reports the chosen interval as a number', async () => {
    const onChange = render({ frequency: 'interval', intervalMinutes: 15, syncMode: 'delta' });
    await userEvent.selectOptions(selectAfter('Every'), '5');
    expect(onChange).toHaveBeenCalledWith({ frequency: 'interval', intervalMinutes: 5, syncMode: 'delta' });
  });
});
