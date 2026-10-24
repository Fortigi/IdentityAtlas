// @vitest-environment jsdom
//
// The builder's sections, for the states the page mount test does not reach: the
// preview button's three labels and the stale-preview hint, a failed-save message,
// Save staying off for a whitespace-only name, and a truncated preview.
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';
import { BuilderHeader, DefinitionPanel, PreviewResults } from './ReportBuilderParts';

const CATALOG = {
  entities: {
    user: {
      label: 'User',
      defaultColumns: ['displayName'],
      compareRelations: [],
      relations: [],
      fields: [{ name: 'displayName', label: 'Display name', type: 'string' }],
      columns: [{ key: 'displayName', label: 'Display name' }],
    },
  },
  operators: { equals: { label: 'is', needsValue: true } },
  operatorsByType: { string: ['equals'] },
};
const SPEC = { entity: 'user', match: 'all', conditions: [], columns: ['displayName'] };
const RESULT = { explanation: null, sql: 'SELECT 1', params: [], elapsedMs: 3, columns: [], rows: [], total: 2, truncated: true };

const panel = (props) => renderWithProviders(
  <DefinitionPanel spec={SPEC} catalog={CATALOG} dirty={false} result={null} running={false} onEdit={() => {}} onRun={() => {}} {...props} />,
);

describe('DefinitionPanel', () => {
  it.each([
    ['never previewed', { result: null, dirty: false }, 'Preview', false],
    ['previewed and unchanged', { result: RESULT, dirty: false }, 'Refresh preview', false],
    ['previewed then edited', { result: RESULT, dirty: true }, 'Preview', true],
    ['edited before any preview', { result: null, dirty: true }, 'Preview', false],
  ])('%s → "%s"', (_why, props, label, stale) => {
    panel(props);
    expect(screen.getByRole('button', { name: label })).toBeEnabled();
    expect(screen.queryByText('edited — preview is out of date') !== null).toBe(stale);
  });

  it('shows the run in progress and blocks a second one', () => {
    panel({ running: true, result: RESULT });
    expect(screen.getByRole('button', { name: 'Running…' })).toBeDisabled();
  });
});

describe('BuilderHeader', () => {
  const header = (props) => renderWithProviders(
    <BuilderHeader isNew={false} name="Guests" message={null} saving={false} onOpenReport={() => {}} onDelete={() => {}} onSave={() => {}} {...props} />,
  );

  it('does not offer Save for a name that is only spaces', () => {
    header({ name: '   ' });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('shows a failed save as an error and opens the saved report on request', async () => {
    const onOpenReport = vi.fn();
    header({ message: { kind: 'err', text: 'Name taken' }, onOpenReport });
    expect(screen.getByRole('status')).toHaveTextContent('Name taken');
    expect(screen.getByRole('status')).toHaveClass('text-red-700');
    await userEvent.click(screen.getByRole('button', { name: 'Open report' }));
    expect(onOpenReport).toHaveBeenCalledTimes(1);
  });

  it('offers neither Open nor Delete for a report that was never saved', () => {
    header({ isNew: true, saving: true });
    expect(screen.queryByRole('button', { name: 'Open report' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  });
});

describe('PreviewResults', () => {
  it('pluralises the row count and says when only the first rows came back', () => {
    renderWithProviders(<PreviewResults name="" confirm={null} running={false} runError={null} result={RESULT} onChoose={() => {}} />);
    expect(screen.getByText(/^Preview: 2 rows \(first rows only\)$/)).toBeInTheDocument();
  });
});
