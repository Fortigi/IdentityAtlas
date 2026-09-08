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

1. Open **Matrix** and build the view you want to share (or load a saved one).
2. Click **Share view…** in the matrix toolbar.
3. Give the view a name — the recipient sees it, and so does everyone on the Shared matrices page.
4. Click **Create link**, then **Copy link**.

The link is shown **once**. Only a hash of its token is stored, so it cannot be recovered later; if you lose it, create a new share and revoke the old one.

The button appears only if your role has the **Create matrix share links** (`data.share`) permission. Out of the box that is the **RoleMiner** role (and Admin, via the wildcard). To let Servicedesk share as well, tick the permission for that role in **Admin → Authentication → Roles & Permissions**. See [Permissions & Role Mapping](../reference/permissions.md).

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

**Shared matrices** in the top navigation lists every share in the organisation — not just your own — with:

- the view's name and who shared it, and when;
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
