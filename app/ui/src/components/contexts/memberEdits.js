// Taking a member out of a context created here (the only kind whose member edits
// last): DELETE /api/contexts/:id/members/:memberId. Shared by the members table
// and the People overview's edit mode. Resolves to true when it went through;
// a refusal is logged and resolves to false (the list stays as it is).

export async function removeContextMember(authFetch, contextId, memberId) {
  try {
    const r = await authFetch(`/api/contexts/${contextId}/members/${memberId}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 204) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${r.status}`);
    }
    return true;
  } catch (err) {
    console.error('Remove member failed:', err);
    return false;
  }
}
