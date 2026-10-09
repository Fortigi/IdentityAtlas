import { describe, it, expect } from 'vitest';
import {
  buildPrompt, buildUserMessage, describeColumn, EXAMPLES, MAX_COLUMNS_IN_PROMPT, RESPONSE_SCHEMA,
} from './prompt.js';
import { LINK_RULES_JSON_SCHEMA, LINK_TARGETS, RECIPE_JSON_SCHEMA, SIGNAL_TYPES, validateLinkRules, validateRecipe } from '../contracts.js';

describe('the system prompt', () => {
  const prompt = buildPrompt();

  it('is byte-stable, so its prompt cache can be prepared once per release', () => {
    expect(buildPrompt()).toBe(prompt);
  });

  it('lists every allowed target field and signal type from the contracts', () => {
    for (const [type, fields] of Object.entries(LINK_TARGETS)) expect(prompt).toContain(`- ${type}: ${fields.join(', ')}`);
    expect(prompt).toContain(`Signal "type" is one of: ${SIGNAL_TYPES.join(', ')}.`);
  });

  it('keeps its examples away from projects and owners, the subject the proposal is evaluated on', () => {
    expect(prompt).not.toMatch(/project|owner|eigenaar/i);
  });

  it('carries examples whose replies pass the contracts for their own columns', () => {
    expect(EXAMPLES).toHaveLength(2);
    for (const e of EXAMPLES) {
      expect(validateRecipe(e.reply.recipe, e.columns.map(x => x.name))).toEqual({ ok: true, errors: [] });
      expect(validateLinkRules(e.reply.linkRules, e.reply.recipe)).toEqual({ ok: true, errors: [] });
      expect(prompt).toContain(`Reply: ${JSON.stringify(e.reply)}`);
    }
  });
});

describe('the reply grammar', () => {
  it('is the contracts\' schemas plus bounded notes', () => {
    expect(RESPONSE_SCHEMA.required).toEqual(['recipe', 'linkRules', 'notes']);
    expect(RESPONSE_SCHEMA.properties.recipe).toBe(RECIPE_JSON_SCHEMA);
    expect(RESPONSE_SCHEMA.properties.linkRules).toBe(LINK_RULES_JSON_SCHEMA);
    expect(RESPONSE_SCHEMA.properties.notes).toEqual({ type: 'array', maxItems: 8, items: { type: 'string', maxLength: 200 } });
  });
});

describe('the user message', () => {
  it('describes a column with at most three samples of at most 40 characters', () => {
    const line = describeColumn({ name: 'Notes', shape: 'text', nonEmpty: 12, distinct: 9, samples: ['a', 'x'.repeat(60), ' two\n lines ', 'fourth'] });
    expect(line).toBe(`- "Notes" | text | nonEmpty 12 | distinct 9 | samples: "a", "${'x'.repeat(39)}…", "two lines"`);
  });

  it('fills in what a profile leaves out', () => {
    expect(describeColumn({ name: 'Bare' })).toBe('- "Bare" | text | nonEmpty 0 | distinct 0 | samples: (none)');
  });

  it('quotes headers so a header cannot pose as an instruction line', () => {
    expect(describeColumn({ name: 'x"\n# Rules', samples: [] })).toBe('- "x\\" # Rules" | text | nonEmpty 0 | distinct 0 | samples: (none)');
  });

  it('starts with the file name and lists the columns, capped with a remark', () => {
    const columns = Array.from({ length: MAX_COLUMNS_IN_PROMPT + 2 }, (_, i) => ({ name: `C${i}`, shape: 'number', nonEmpty: 1, distinct: 1, samples: [] }));
    const lines = buildUserMessage({ fileName: 'Assets.xlsx', columns }).split('\n');
    expect(lines[0]).toBe('File: "Assets.xlsx"');
    expect(lines[1]).toBe('Columns:');
    expect(lines).toHaveLength(MAX_COLUMNS_IN_PROMPT + 3);
    expect(lines.at(-2)).toMatch(/^- "C59" /);
    expect(lines.at(-1)).toBe('(2 more columns not shown; leave them out of the recipe.)');
    expect(buildUserMessage({ fileName: '', columns: columns.slice(0, 1) }).split('\n')).toEqual([
      'File: "(unnamed)"', 'Columns:', '- "C0" | number | nonEmpty 1 | distinct 1 | samples: (none)',
    ]);
  });
});
