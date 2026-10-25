// The built-in survey templates are added once, by key, and never overwritten.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./store.js', async (orig) => ({ ...(await orig()), keyExists: vi.fn() }));
vi.mock('./service.js', async (orig) => ({ ...(await orig()), createTemplate: vi.fn() }));
vi.mock('./seedTemplates.js', () => ({
  SEED_TEMPLATES: [
    { key: 'a', name: 'A', contextCategory: 'LogicalApplication', definition: { schemaVersion: 1, languages: ['en'], title: 'A', sections: [{ id: 's', questions: [{ id: 'q', text: 'Q', answer: { type: 'yesNo' } }] }] } },
    { key: 'b', name: 'B', contextCategory: 'OrganizationalUnit', definition: { schemaVersion: 1, languages: ['en'], title: 'B', sections: [{ id: 's', questions: [{ id: 'q', text: 'Q', answer: { type: 'yesNo' } }] }] } },
  ],
}));

const store = await import('./store.js');
const { createTemplate } = await import('./service.js');
const seedTemplates = await import('./seedTemplates.js');
const { seedSurveyTemplates } = await import('./seed.js');

beforeEach(() => vi.clearAllMocks());

describe('seedSurveyTemplates', () => {
  it('adds only the keys that are not there, as built-in templates by the system', async () => {
    store.keyExists.mockImplementation(async (_db, key) => key === 'a');
    const db = {};
    expect(await seedSurveyTemplates({ db })).toEqual(['b']);
    expect(createTemplate).toHaveBeenCalledTimes(1);
    expect(createTemplate.mock.calls[0][0]).toMatchObject({ key: 'b', builtIn: true });
    expect(createTemplate.mock.calls[0].slice(1)).toEqual(['system', { db }]);
  });

  it('does nothing when every key is there', async () => {
    store.keyExists.mockResolvedValue(true);
    expect(await seedSurveyTemplates({ db: {} })).toEqual([]);
    expect(createTemplate).not.toHaveBeenCalled();
  });

  it('refuses to seed an invalid built-in template, naming it', async () => {
    store.keyExists.mockResolvedValue(false);
    seedTemplates.SEED_TEMPLATES[0].definition.languages = [];
    await expect(seedSurveyTemplates({ db: {} })).rejects.toThrow(/Seed survey template a is invalid: languages/);
  });
});
