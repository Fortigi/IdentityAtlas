// @vitest-environment jsdom
//
// The shared wizard field primitives, used by every crawler wizard.
//
// The structural assertions are the load-bearing ones: the crawler e2e tests
// select fields with `label:has-text("X") + input`, so the label and its control
// have to stay SIBLINGS. A refactor that nested the input inside the label would
// look identical on screen and silently break every wizard's end-to-end coverage.
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { CrawlerField, OptionList, WizardNav, ScheduleList } from './wizardFields';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';

describe('CrawlerField', () => {
  const render = (props) => renderWithProviders(h(CrawlerField, { value: '', onChange: vi.fn(), ...props }));

  it('keeps the label and the input as siblings — the e2e selectors depend on it', () => {
    render({ label: 'Username' });
    const label = screen.getByText('Username');
    const input = screen.getByRole('textbox');
    expect(label.nextElementSibling).toBe(input);
  });

  it('reports the typed value, not the event', async () => {
    const onChange = vi.fn();
    render({ label: 'Base URL', onChange });
    await userEvent.type(screen.getByRole('textbox'), 'x');
    expect(onChange).toHaveBeenCalledWith('x');
  });

  it('marks an optional field without changing its label text', () => {
    render({ label: 'Scope', optional: true });
    expect(screen.getByText('Scope')).toBeInTheDocument();
    expect(screen.getByText('(optional)')).toBeInTheDocument();
  });

  it('renders a hint under the control when given one, and nothing when not', () => {
    const { unmount } = render({ label: 'A', hint: 'how this is used' });
    expect(screen.getByText('how this is used')).toBeInTheDocument();
    unmount();
    render({ label: 'A' });
    expect(screen.queryByText('how this is used')).not.toBeInTheDocument();
  });

  it('masks a secret field', () => {
    render({ label: 'Password', type: 'password', placeholder: '••••' });
    expect(screen.getByPlaceholderText('••••')).toHaveAttribute('type', 'password');
  });

  it('renders a textarea instead of an input when given rows', () => {
    // The cookie field is multi-line; a single-line input would truncate what a
    // user pastes in without saying so.
    render({ label: 'Cookie String', rows: 3 });
    const box = screen.getByRole('textbox');
    expect(box.tagName).toBe('TEXTAREA');
    expect(box).toHaveAttribute('rows', '3');
  });

  it('renders extra content passed as children, under the control', () => {
    render({ label: 'Cookie String', rows: 3, children: h('button', null, 'How do I get this?') });
    expect(screen.getByRole('button', { name: 'How do I get this?' })).toBeInTheDocument();
  });
});

describe('OptionList', () => {
  const OPTIONS = [
    { id: 'a', label: 'Alpha', description: 'the first' },
    { id: 'b', label: 'Beta', description: 'the second' },
  ];

  it('renders radios with only the selected one checked', () => {
    renderWithProviders(h(OptionList, { options: OPTIONS, name: 'x', selected: 'b', onSelect: vi.fn() }));
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(radios[0]).not.toBeChecked();
    expect(radios[1]).toBeChecked();
    expect(screen.getByText('the first')).toBeInTheDocument();
  });

  it('reports the chosen key when a radio is picked', async () => {
    const onSelect = vi.fn();
    renderWithProviders(h(OptionList, { options: OPTIONS, name: 'x', selected: 'a', onSelect }));
    await userEvent.click(screen.getByText('Beta'));
    expect(onSelect).toHaveBeenCalledWith('b', true);
  });

  it('renders checkboxes from a selection map, and reports checked state', async () => {
    const onSelect = vi.fn();
    const opts = [{ key: 'users', label: 'Users' }, { key: 'groups', label: 'Groups' }];
    renderWithProviders(h(OptionList, {
      options: opts, type: 'checkbox', selected: { users: true, groups: false }, onSelect,
    }));
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).not.toBeChecked();

    await userEvent.click(boxes[1]);
    expect(onSelect).toHaveBeenCalledWith('groups', true);
  });
});

describe('WizardNav', () => {
  it('shows only Next on the first step', () => {
    renderWithProviders(h(WizardNav, { onNext: vi.fn() }));
    expect(screen.getByRole('button', { name: 'Next →' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '← Back' })).not.toBeInTheDocument();
  });

  it('shows Back and Next once there is somewhere to go back to', async () => {
    const onBack = vi.fn();
    const onNext = vi.fn();
    renderWithProviders(h(WizardNav, { onBack, onNext }));
    await userEvent.click(screen.getByRole('button', { name: '← Back' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next →' }));
    expect(onBack).toHaveBeenCalled();
    expect(onNext).toHaveBeenCalled();
  });

  it('disables Next while the step is incomplete, so it cannot be clicked past', async () => {
    const onNext = vi.fn();
    renderWithProviders(h(WizardNav, { onNext, nextDisabled: true }));
    const next = screen.getByRole('button', { name: 'Next →' });
    expect(next).toBeDisabled();
    await userEvent.click(next);
    expect(onNext).not.toHaveBeenCalled();
  });

  it('takes a custom label for the final save button', () => {
    renderWithProviders(h(WizardNav, { onBack: vi.fn(), onNext: vi.fn(), nextLabel: 'Add Crawler' }));
    expect(screen.getByRole('button', { name: 'Add Crawler' })).toBeInTheDocument();
  });
});

describe('ScheduleList', () => {
  it('says so when nothing is scheduled', () => {
    renderWithProviders(h(ScheduleList, { schedules: [], onChange: vi.fn() }));
    expect(screen.getByText(/No schedules configured/)).toBeInTheDocument();
  });

  it('adds a daily full-sync schedule, and drops the empty-state line', async () => {
    const onChange = vi.fn();
    renderWithProviders(h(ScheduleList, { schedules: [], onChange }));
    await userEvent.click(screen.getByRole('button', { name: '+ Add Schedule' }));
    expect(onChange).toHaveBeenCalledWith([
      { enabled: true, syncMode: 'full', frequency: 'daily', hour: 2, minute: 0 },
    ]);
  });

  it('lets a crawler override the schedule it adds', async () => {
    const onChange = vi.fn();
    renderWithProviders(h(ScheduleList, {
      schedules: [], onChange, defaultSchedule: { syncMode: 'delta', hour: 5 },
    }));
    await userEvent.click(screen.getByRole('button', { name: '+ Add Schedule' }));
    expect(onChange).toHaveBeenCalledWith([
      { enabled: true, syncMode: 'delta', frequency: 'daily', hour: 5, minute: 0 },
    ]);
  });

  it('renders an editor per configured schedule instead of the empty state', () => {
    renderWithProviders(h(ScheduleList, {
      schedules: [{ frequency: 'daily', hour: 2, minute: 0, syncMode: 'full' }], onChange: vi.fn(),
    }));
    expect(screen.queryByText(/No schedules configured/)).not.toBeInTheDocument();
  });
});
