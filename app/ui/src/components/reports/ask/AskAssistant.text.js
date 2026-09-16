// The words the assistant shows around the question box, chosen from its state.

// What the status line next to the button says while the model warms up.
export function warmStatusText(warm, elapsed) {
  switch (warm) {
    case 'warming': return `loading the model… ${elapsed}s`;
    case 'starting': return `loading the model into memory — usually under a minute… ${elapsed}s`;
    case 'preparing': return `the model is preparing its prompt cache (first time after an update) — questions work but are slow… ${elapsed}s`;
    case 'error': return 'model server did not respond';
    default: return '';
  }
}

// Why the generator can't be used, from the /status answer.
export function unavailableReason(status) {
  return status?.reason === 'model-not-installed'
    ? `model "${status.model}" is not installed`
    : 'the local model server is not reachable';
}

// The question box's label and placeholder: answering a clarifying question,
// changing the definition in the builder, or describing a new report.
export function questionPrompt({ awaitingAnswer, currentSpec }) {
  if (awaitingAnswer) return { label: 'Your answer', placeholder: 'Or type your own answer…' };
  if (currentSpec) {
    return { label: 'Describe a change to the report', placeholder: 'Describe a change, e.g. "only enabled accounts, and show the department"…' };
  }
  return { label: 'Describe the report you want', placeholder: 'e.g. all guest accounts without a manager' };
}

// How long a reply took, and how much the model read and wrote for it.
export function formatTiming(t) {
  if (!t) return '';
  const s = (ms) => `${(ms / 1000).toFixed(1)}s`;
  return `${s(t.totalMs)} · read ${t.promptTokens} tokens in ${s(t.promptMs)} · wrote ${t.outputTokens} tokens in ${s(t.outputMs)}`;
}
