// business-process-llm plugin.
//
// An LLM-driven clusterer: the analyst supplies a textual description of the
// business process (or several), and the plugin asks the configured LLM to
// assign each resource to the process it most likely supports. One context
// is produced per process; unmatched resources are dropped.
//
// This is a stub implementation. The full version depends on the tenant's
// LLM provider being configured and approved for this use case. Running
// without a provider yields a clear error; the plugin is registered so it
// shows up in the picker and documents its parameter shape.

/** @type {import('./types.js').ContextPlugin} */
export default {
  name: 'business-process-llm',
  displayName: 'Business Process (LLM)',
  description: 'Uses the configured LLM to cluster resources by the business process they support. Requires an approved LLM provider — configure on Admin → LLM Settings.',
  targetType: 'Resource',
  parametersSchema: {
    type: 'object',
    required: ['processes', 'llmProviderId'],
    properties: {
      scopeSystemId:  { type: 'integer', description: 'Systems.id — limit to one system. Leave blank for all.' },
      llmProviderId:  { type: 'integer', description: 'Secrets row id for the LLM provider to use.' },
      processes: {
        type: 'array',
        description: 'Process descriptions. The LLM sees each resource once against this list.',
        items: {
          type: 'object',
          required: ['name', 'description'],
          properties: {
            name:        { type: 'string', description: 'Short process label (used as the context displayName).' },
            description: { type: 'string', description: 'One paragraph describing the process.' },
          },
        },
      },
      maxResources: { type: 'integer', default: 500, description: 'Safety cap on how many resources are sent to the LLM.' },
    },
  },
  async run(_params, _ctx) {
    throw new Error(
      'The business-process-llm plugin is not yet fully implemented. ' +
      'It is registered so analysts can see its parameter shape; flip it on in a follow-up patch ' +
      'once the LLM-call wiring for generated contexts is wired up.'
    );
  },
};
