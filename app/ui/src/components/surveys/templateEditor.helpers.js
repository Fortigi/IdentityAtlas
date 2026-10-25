// The survey template editor — the pure part (TemplateEditor.jsx).

/** What a new template starts with: one section, one question, valid as it stands. */
export const NEW_DEFINITION = {
  schemaVersion: 1,
  languages: ['en'],
  title: 'New survey: {context}',
  sections: [{
    id: 'main',
    questions: [{ id: 'q1', text: 'Is {context} still in use?', required: true, answer: { type: 'yesNo' }, becomes: { kind: 'property', attribute: 'inUse' } }],
  }],
};

/** The JSON text parsed, or { error } with the parser's message. */
export function parseJson(text) {
  try {
    return { value: JSON.parse(text) };
  } catch (e) {
    return { error: e.message };
  }
}
