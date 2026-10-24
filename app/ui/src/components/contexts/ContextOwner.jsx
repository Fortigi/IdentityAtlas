// ─── The owner of a context, as a person ──────────────────────────────────
//
// `ownerUserId` is free text: whatever the source system calls the owner of a
// grouping. The contexts read endpoints resolve it against Principals (see
// routes/contexts/read.js) and hand back `ownerPrincipalId` +
// `ownerDisplayName` when it names somebody we hold.
//
// Resolved   → the person's name, clickable through to their account.
// Unresolved → the raw value, plain. It is all we honestly know, and a source
//              that names an owner nobody can find is a fact worth seeing:
//              blanking it would hide the very defect the reader needs (the
//              SQL catalogue that stores an employee number where principals
//              are keyed on the identity id did exactly that).
//
// Shared by the context detail header and the contexts page so the two cannot
// drift into showing the owner two different ways.

const BADGE = 'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded ' +
  'bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300 ' +
  'border border-amber-200 dark:border-amber-700';

export default function ContextOwner({ attrs, onOpenDetail }) {
  const ownerUserId = attrs?.ownerUserId;
  if (!ownerUserId) return null;

  const principalId = attrs.ownerPrincipalId;
  // A resolved principal with no display name still beats the raw id as a
  // link target, so fall back to the id for the label but keep the link.
  const label = principalId ? (attrs.ownerDisplayName || ownerUserId) : ownerUserId;

  if (!principalId || !onOpenDetail) {
    return (
      <span
        className={BADGE}
        title={principalId ? `Owner id: ${ownerUserId}` : `Owner "${ownerUserId}" does not match any account we hold`}
      >
        Owner: {label}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpenDetail('user', principalId, label)}
      className={`${BADGE} hover:bg-amber-100 dark:hover:bg-amber-900/50 underline decoration-dotted underline-offset-2`}
      title={`Owner id: ${ownerUserId}`}
    >
      Owner: {label}
    </button>
  );
}
