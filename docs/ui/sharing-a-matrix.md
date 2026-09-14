---
type: task
prereq: architecture/matrix.md
outcome: You can save and share a matrix in one act, see and change who it is shared with from the matrix itself, and stop sharing at any time.
---

# Share a matrix with someone in your organisation

!!! info "Before this page"
    Assumes you have read **[Reading the Matrix](../architecture/matrix.md)** and can build a matrix in the wizard.

You have configured a matrix that answers a question someone else has: a manager who wants to see their team's access, an application owner who wants to see who can reach their resource. Sharing turns that matrix into a link. The recipient signs in with their normal Microsoft account — **no Identity Atlas role required** — and sees the matrix and nothing else: no navigation, no dashboard, no wizard, no export buttons. They can click a resource or a person and read the detail page, then come back.

!!! note "Experimental — switched off by default"
    Matrix sharing is an [experimental feature](../reference/experimental-features.md#matrix-sharing). An administrator turns it on under **Admin → Experimental → Matrix sharing**. While it is off, none of the controls on this page appear and share links do not open.

**A share is a property of a saved matrix.** There is one object and one name: sharing a matrix that isn't saved yet saves it and shares it in a single step, and sharing one that is already saved never asks you to name it again.

Recipients see the matrix **as it stands** — both the data and the view. Save a change to a shared matrix and your recipients see that change; the app tells you how many people that is before you save.

---

## 1. The strip above the matrix

Directly above every matrix sits one row. On its left it answers three questions without opening anything; on its right are the matrix's live counts (users × resources · cells) and **Adjust**:

| Control | What it says / does |
|---|---|
| The name ▾ | Which saved matrix you are looking at, or **Unsaved matrix**. Opens a menu listing every saved matrix in the org (shared ones say so underneath their name) — picking one opens it — plus **New matrix…** and, for the saved matrix on screen, **Rename…**, **Duplicate…** and **Delete…**. |
| **Unsaved changes** | Shown only when you opened a saved matrix and then changed it. Click it to go straight to the wizard's last step to save the changes. |
| **Shared with n people** | Shown only when the saved matrix is shared. Opens the recipients panel. |

With no matrix on screen, the Matrix tab shows **Open a matrix**: every saved matrix with when it last changed, and **New matrix**.

Opening a matrix and the wizard's **Apply** change what is on screen. Saving stores a matrix for the org. They are separate, deliberately — neither one quietly does the other.

## 2. Save and share, in one act

Sharing is usually the last thing you do to a matrix you built *for* somebody, so it is also the wizard's last step — you don't have to apply the matrix first and then go looking for a button. The bar's share control and the wizard's **Share** step open the same panel.

1. Open **Matrix** → **Adjust matrix** (or build a new one) and work through the steps as usual.
2. On the last step, **Share**, name the matrix — **once**. It is saved org-wide under that name, and recipients and the Shared matrices page see the same name.
3. Under **Share with**, search the directory by name or e-mail and pick the people it is for. You can add several; each appears as a chip you can remove again.
4. Click **Save & share**, then **Copy share link**.

If the matrix is already saved, step 2 does not appear at all and the button reads **Share matrix**.

The wizard step is optional: pressing **Apply** without touching it is the ordinary path, and **Apply** stays available while the form is open. It only appears for a role that may share (see below), and a matrix that is [too large to load](../architecture/matrix.md) shows the reason instead of the form — a recipient cannot narrow a share down, so there is nothing useful to send them.

**Names are unique org-wide.** A name that is already taken comes back as an error under the field, asking for a different one. Nothing is ever silently overwritten.

**At least one recipient is required** — the button stays disabled until you have named somebody. There is no "anyone with the link" share: only the people you picked (and you) can open it, so a forwarded link is useless to anyone else, and they are told plainly that the view was shared with specific people.

Sharing appears only if your role has the **Create matrix share links** (`data.share`) permission. Out of the box that is the **RoleMiner** role (and Admin, via the wildcard). To let Servicedesk share as well, tick the permission for that role in **Admin → Authentication → Roles & Permissions**. See [Permissions & Role Mapping](../reference/permissions.md).

## 3. Change who it is shared with, or stop sharing

Open the **Shared with n people** chip on the matrix bar, the **Share** step of **Adjust matrix**, or **Manage** on the Admin row — all three open the same panel:

- **Add or remove people.** The link does not change. Somebody you remove loses access immediately, on their very next request.
- **Copy share link.** Unlike the one-time token this replaced, a link can be copied again at any time.
- **Stop sharing.** The link stops working; the saved matrix stays and can be shared again later, which issues a **new** link.

Deleting a saved matrix that is shared warns you first, naming how many people it reaches, and stops its link when you go ahead.

## 4. What the recipient gets

They open the link, sign in if they aren't already, and land on a single page: a slim header with the matrix's name, and the matrix as it currently stands. The analyst context around the matrix — the strip above it (the matrix's name menu, its sharing, the user/resource/cell counts, Adjust) and the scope statistics (principal/resource/assignment totals, the governed bar, Trends & breakdown — left out even when the matrix was saved with them switched on) — is dropped. Clicking a person or a resource opens its detail page — attributes and relationships, read-only — with a **Back to matrix** button. The analyst-only tabs (Timeline, Risk) and every write action are absent.

If the link has been revoked, was mistyped, or no longer resolves, they get a plain sentence explaining that, not an error page.

## 5. See every share, org-wide

**Admin → Shared Matrices** lists every share in the organisation — not just your own. Managing other people's links is an administrative job, so it sits with the other org-wide controls rather than in the top navigation. (A `#shared-matrices` link from an older build still works — it lands on the Admin tab.) The page shows:

- the view's name and who shared it, and when;
- **who it was shared with** — the people you picked;
- **who has opened it**, how many times, and when they last did. Because every recipient signs in, this is per person, not just a "last used" stamp. A link nobody ever opened reads **Never opened**, which makes unused links easy to clean up;
- whether it is still active, a **Manage** button (the same panel as above) and a **Revoke** button.

Revoking is immediate and permanent for that link — the recipient sees the "no longer shared" page from then on. Usage history survives the revoke, so the record of who saw what is not erased, and the saved matrix itself is untouched.

---

## What sharing does *not* do

- **It does not narrow the recipient's data access.** The bare shell is a UI simplification, not a data boundary: a recipient is a signed-in reader, and a technically capable one could query other read endpoints while signed in. Share with people you would be comfortable giving read access to — for genuinely scoped access, wait for the matrix-scoping work tracked under [#1105](https://github.com/Fortigi/IdentityAtlas/issues/1105).
- **It does not send e-mail.** Copy the link and send it however you normally would.
- **It does not expire.** There is no time limit; stop sharing when you're done.
- **It does not freeze the view.** Recipients track the live saved matrix, by design. If you need somebody to keep seeing a particular slice, save that slice under its own name and share that.

## Deployment caveats (auth-enabled installs)

Sharing relies on a *roleless* tenant user being able to sign in and read. Two deployment settings break that, deliberately, and sharing does not weaken either:

- **`AUTH_REQUIRED_ROLES`** — when set, the API rejects users who hold none of the listed app roles before any share logic runs. On such a deployment your recipients need one of those roles.
- **"Assignment required?" on the Entra app** — when enabled, a user who isn't assigned to the app cannot sign in at all, so they cannot open a share link.

On an install with authentication disabled the link simply opens the bare view, and usage is recorded against `anonymous`.
