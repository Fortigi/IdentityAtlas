// Read a fetch() Response body as UTF-8 text under a hard byte cap.
//
// Shared by every outbound fetch whose response size is controlled by someone
// else — an LLM provider (llm/providers.js) or an admin-configured feed URL
// (contexts/plugins/riskyAppFeed.js) — so a buggy or hostile server cannot stream
// an unbounded body into the API's memory. A declared Content-Length over the cap
// is refused before reading; otherwise the stream is read chunk by chunk and
// abandoned the moment it crosses the cap.
export async function readCappedBody(resp, maxBytes, label = 'Response') {
  const declared = Number(resp.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`${label} too large (${declared} bytes > ${maxBytes}-byte cap)`);
  }
  const reader = resp.body?.getReader?.();
  if (!reader) return resp.text(); // no readable stream; platform already bounded it
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`${label} exceeded ${maxBytes}-byte cap`);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}
