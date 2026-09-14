// The share↔saved-matrix seam (#1202) — the few pieces both the create path
// and the recipient-editing path need, kept out of shares.js so neither route
// grows a private copy.
//
// Nothing here touches the pool: every function takes the transaction client it
// should run on, because both callers are mid-transaction when they use them.

// A route-level failure raised from inside a db.tx callback. The transaction
// unwinds (so a half-made share can never survive) and the route maps `status`
// onto the response instead of reporting a blanket 500.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The filter as a SAVED MATRIX stores it. The governed toggle lives in the
// matrix toolbar rather than the wizard, but it is part of what was shared, so
// it is folded into the filter — the same shape the wizard's own save writes.
// The display mode needs no folding: it is already derivable from the filter's
// `orientation` / roll-up keys, which is why the UI derives it there too.
export function savedMatrixShape(filter, managed) {
  return managed ? { ...filter, managed } : { ...filter };
}

// Write the people a share is addressed to. `ON CONFLICT … DO UPDATE` rather
// than `DO NOTHING` so re-adding somebody who is already on the list refreshes
// the name the sharer picked instead of silently keeping a stale one, and a
// principal id picked this time is never dropped in favour of an earlier null.
export async function insertRecipients(client, shareId, recipients) {
  const values = recipients.map((_, i) => `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4})`).join(', ');
  await client.query(
    `INSERT INTO "MatrixShareRecipients" ("shareId", "principalId", "userKey", "displayName")
     VALUES ${values}
     ON CONFLICT ("shareId", "userKey") DO UPDATE
       SET "displayName" = COALESCE(EXCLUDED."displayName", "MatrixShareRecipients"."displayName"),
           "principalId" = COALESCE(EXCLUDED."principalId", "MatrixShareRecipients"."principalId")`,
    [shareId, ...recipients.flatMap(r => [r.principalId, r.userKey, r.displayName])],
  );
}
