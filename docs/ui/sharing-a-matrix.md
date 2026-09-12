---
type: task
prereq: architecture/matrix.md
outcome: You can share a configured matrix with a colleague who has no Identity Atlas role, and see and revoke every share afterwards.
---

# Share a matrix with someone in your organisation

!!! info "Before this page"
    Assumes you have read **[Reading the Matrix](../architecture/matrix.md)** and can build a matrix in the wizard.

You have configured a matrix that answers a question someone else has: a manager who wants to see their team's access, an application owner who wants to see who can reach their resource. Sharing turns that matrix into a link. The recipient signs in with their normal Microsoft account — **no Identity Atlas role required** — and sees the matrix and nothing else: no navigation, no dashboard, no wizard, no export buttons. They can click a resource or a person and read the detail page, then come back.

The **data** behind a shared view stays live. The **view** does not: the filter is snapshotted at the moment you share, so editing (or deleting) the saved filter afterwards never silently changes what your recipient sees.

---

## 1. Create the link

Sharing is usually the last thing you do to a matrix you built *for* somebody, so it is the last step of the wizard — you don't have to apply the matrix first and then go looking for a button.

### From the wizard (**Share**, the final step)

1. Open **Matrix** → **Adjust matrix** (or build a new one) and work through the steps as usual.
2. On the last step, **Share**, name the view — the recipients see that name, and so does everyone on the Shared matrices page.
3. Under **Share with**, search the directory by name or e-mail and pick the people it is for. You can add several; each appears as a chip you can remove again.
4. Click **Create link**, then **Copy link**.

The step is optional: pressing **Apply** without touching it is the ordinary path, and **Apply** stays available while the form is open. It only appears for a role that may share (see below), and a matrix that is [too large to load](../architecture/matrix.md) shows the reason instead of the form — a recipient cannot narrow a share down, so there is nothing useful to send them.

### From the matrix toolbar

Already looking at the matrix? Click **Share view…** in the toolbar for the same form. (Not to be confused with **Copy link** next to it: that copies the current URL, which only opens for colleagues who already have Identity Atlas access.)

### Either way

**At least one recipient is required** — **Create link** stays disabled until you have named somebody. There is no "anyone with the link" share: only the people you picked (and you) can open it, so a forwarded link is useless to anyone else, and they are told plainly that the view was shared with specific people.

The link is shown **once**. Only a hash of its token is stored, so it cannot be recovered later; if you lose it, create a new share and revoke the old one.

Sharing appears only if your role has the **Create matrix share links** (`data.share`) permission. Out of the box that is the **RoleMiner** role (and Admin, via the wildcard). To let Servicedesk share as well, tick the permission for that role in **Admin → Authentication → Roles & Permissions**. See [Permissions & Role Mapping](../reference/permissions.md).

What the snapshot captures:

| Captured | Notes |
|---|---|
| The wizard filter | Subjects and resources, includes and excludes |
| The governed toggle | All / Governed / Non-governed / Gaps, as you had it |
| The display mode | Grid, rotated (resources as columns) or roll-up |

## 2. What the recipient gets

They open the link, sign in if they aren't already, and land on a single page: a slim header with the view's name, and the matrix. Clicking a person or a resource opens its detail page — attributes and relationships, read-only — with a **Back to matrix** button. The analyst-only tabs (Timeline, Risk) and every write action are absent.

If the link has been revoked, was mistyped, or no longer resolves, they get a plain sentence explaining that, not an error page.

## 3. See and revoke shares

**Admin → Shared Matrices** lists every share in the organisation — not just your own. Managing other people's links is an administrative job, so it sits with the other org-wide controls rather than in the top navigation. (A `#shared-matrices` link from an older build still works — it lands on the Admin tab.) The page shows:

- the view's name and who shared it, and when;
- **who it was shared with** — the people you picked;
- **who has opened it**, how many times, and when they last did. Because every recipient signs in, this is per person, not just a "last used" stamp. A link nobody ever opened reads **Never opened**, which makes unused links easy to clean up;
- whether it is still active, and a **Revoke** button.

Revoking is immediate and permanent for that link — the recipient sees the "no longer shared" page from then on. Usage history survives the revoke, so the record of who saw what is not erased.

---

## What sharing does *not* do

- **It does not narrow the recipient's data access.** The bare shell is a UI simplification, not a data boundary: a recipient is a signed-in reader, and a technically capable one could query other read endpoints while signed in. Share with people you would be comfortable giving read access to — for genuinely scoped access, wait for the matrix-scoping work tracked under [#1105](https://github.com/Fortigi/IdentityAtlas/issues/1105).
- **It does not send e-mail.** Copy the link and send it however you normally would.
- **It does not expire.** There is no time limit; revoke when you're done.

## Deployment caveats (auth-enabled installs)

Sharing relies on a *roleless* tenant user being able to sign in and read. Two deployment settings break that, deliberately, and sharing does not weaken either:

- **`AUTH_REQUIRED_ROLES`** — when set, the API rejects users who hold none of the listed app roles before any share logic runs. On such a deployment your recipients need one of those roles.
- **"Assignment required?" on the Entra app** — when enabled, a user who isn't assigned to the app cannot sign in at all, so they cannot open a share link.

On an install with authentication disabled the link simply opens the bare view, and usage is recorded against `anonymous`.
