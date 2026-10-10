// @vitest-environment jsdom
//
// The wizard's Organisation condition (T8): offered only behind the `orgTruth`
// flag, on both sides and in both lists, and the condition the picker builds
// reaches the applied filter unchanged; a stored one renders as its chip.
import { describe, it, expect } from 'vitest';
import { makeAuthFetch, screen, within } from '@ui/test-utils/renderWithProviders';
import { makeWizardFetch, renderWizard, gotoStep } from '@ui/test-utils/matrixWizardFixtures';

const CONTOSO = '11111111-1111-4111-8111-111111111111';
const ORG_ON = { matrixSharing: true, orgTruth: true };

function orgFetch() {
  const base = makeWizardFetch();
  return makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('/api/org-truth/model')) return { entityTypes: [{ type: 'Klant', count: 61 }] };
    if (u.startsWith('/api/org-truth/filter-options')) {
      return {
        entityType: 'Klant', entityCount: 61,
        attributes: [{ key: 'iso27001', distinct: 2, values: [{ value: 'Ja', count: 14 }, { value: 'Nee', count: 47 }] }],
        vias: [
          { name: 'eigenaar', kind: 'direct', targets: ['Principal'], links: 58 },
          { name: 'team', kind: 'direct', targets: ['Principal'], links: 30 },
        ],
      };
    }
    return base(u, opts);
  });
}

async function showMatrix(user) {
  await gotoStep(user, 'Save & share');
  await user.click(await screen.findByRole('button', { name: 'Show matrix' }));
}

describe('MatrixFilterWizard — Organisation condition', () => {
  it('offers no "+ Organisation" while the orgTruth flag is off', async () => {
    const { user } = renderWizard({}, makeWizardFetch(), { features: { matrixSharing: true } });
    expect(screen.getAllByText('+ Attribute')).toHaveLength(2);
    expect(screen.queryByText('+ Organisation')).not.toBeInTheDocument();
    await gotoStep(user, 'Resources');
    expect(screen.getAllByText('+ Attribute')).toHaveLength(2);
    expect(screen.queryByText('+ Organisation')).not.toBeInTheDocument();
  });

  it('offers it in the Include and Exclude lists of both steps when the flag is on', async () => {
    const { user } = renderWizard({}, orgFetch(), { features: ORG_ON });
    expect(screen.getAllByText('+ Organisation')).toHaveLength(2);
    await gotoStep(user, 'Resources');
    expect(screen.getAllByText('+ Organisation')).toHaveLength(2);
  });

  it('adds the picked condition to the subject excludes, shows its chip and applies it unchanged', async () => {
    const { user, onApply } = renderWizard({}, orgFetch(), { features: ORG_ON });
    await user.click(screen.getAllByText('+ Organisation')[1]); // Exclude list
    const dialog = await screen.findByRole('dialog', { name: 'Add organisation filter' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Kind of entity' }), 'Klant');
    await user.selectOptions(await within(dialog).findByRole('combobox', { name: /Attribute/ }), 'iso27001');
    await user.click(within(dialog).getByRole('checkbox', { name: /^Ja/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: /^team/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    expect(screen.queryByRole('dialog', { name: 'Add organisation filter' })).not.toBeInTheDocument();
    expect(screen.getByText('Organisation · Klant · iso27001 = Ja · via eigenaar')).toBeInTheDocument();

    await showMatrix(user);
    const filter = onApply.mock.calls.at(-1)[0];
    expect(filter.subject.include).toEqual([]);
    expect(filter.subject.exclude).toEqual([
      { kind: 'org', entityType: 'Klant', attribute: { key: 'iso27001', values: ['Ja'] }, via: ['eigenaar'] },
    ]);
  });

  it('renders a stored org condition as its chip and removes it', async () => {
    const initialFilter = {
      rowType: 'principal',
      resource: {
        include: [{ kind: 'org', entityType: 'Klant', entityIds: [CONTOSO], labels: { [CONTOSO]: 'Contoso Bank' } }],
        exclude: [],
      },
    };
    const { user, onApply } = renderWizard({ initialFilter }, orgFetch(), { features: ORG_ON });
    await gotoStep(user, 'Resources');
    const chip = screen.getByText('Organisation · Klant: Contoso Bank');
    await user.click(within(chip.closest('div')).getByRole('button', { name: 'Remove' }));
    expect(screen.queryByText('Organisation · Klant: Contoso Bank')).not.toBeInTheDocument();
    await showMatrix(user);
    expect(onApply.mock.calls.at(-1)[0].resource.include).toEqual([]);
  });
});
