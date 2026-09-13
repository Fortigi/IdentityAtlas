# Experimental features

Some capabilities ship before they have been through much real-world use. Identity
Atlas marks those **experimental** and keeps them behind a switch, so an upgrade
never quietly changes what a production install offers.

An experimental feature is **not** a prototype, a stub, or a half-built screen. It is
finished and covered by the same automated tests as everything else. What it is
missing is mileage:

> **Experimental = built and tested, but it has had only limited opportunity to prove
> itself against real-world systems.**

Most connectors are written against a specification and a mock. Real endpoints are
where the surprises live — a vendor that paginates differently, an attribute that is
optional in the spec but always absent in practice, a quirk that only shows up at
50 000 accounts. Until a feature has met a few of those, it carries the label.

---

## Turning them on

**Admin → Experimental** lists every experimental feature in the running build, with
a switch for each one and the exact contents of each group.

You need the **Feature flags** permission (`admin.feature-flags`) to change a switch —
the same permission that governs the Risk Scoring toggle.

Every switch is **off by default**, including after an upgrade, and your choice is
stored in the database, so it survives container restarts and redeployments.

!!! tip "Setting it from the environment instead"
    Each flag also reads an environment variable, useful for a test deployment that
    should start with it on: `FEATURE_EXPERIMENTAL_CRAWLERS=true`. A switch flipped
    in the Admin UI overrides the environment variable from then on.

---

## Experimental crawlers

It controls whether crawler types marked
experimental are offered in **Admin → Crawlers → Add Crawler**.

| Crawler | What it connects to |
|---|---|
| [SCIM 2.0](../sync/scim.md) | Any SCIM 2.0 service provider — SAP Cloud Identity Services, Okta, a home-grown SCIM façade |

More connectors are expected to arrive this way — a generic OData crawler, for
example. They all sit under this one switch rather than getting a switch each.

### What the switch does, precisely

**On** — experimental crawler types appear in the Add Crawler picker, each marked
with an `Experimental` badge. You configure, schedule and run them like any other
crawler.

**Off** — they are not offered in the picker, and the API refuses to create a new
configuration for one.

### What the switch does *not* do

Turning it off **does not disable an experimental crawler you already configured.**
It keeps its schedule, keeps syncing, keeps its data, and can still be edited,
run on demand, and deleted. The badge stays on its card so you can see what it is.

The switch governs *adding a new one* — nothing else. That is deliberate: an
operator who turns the flag off after connecting a system should not silently lose
that system's data.

---

## Matrix sharing

Lets analysts share a configured matrix with named colleagues who have no Identity
Atlas role — a manager, an application owner. See
[Share a matrix with someone in your organisation](../ui/sharing-a-matrix.md) for the
feature itself. It is experimental because it is the first thing in Identity Atlas
that shows data to people outside the analyst team.

Environment variable: `FEATURE_MATRIX_SHARING=true`.

### What the switch does, precisely

**On** — users with the **Create matrix share links** (`data.share`) permission get
the wizard's **Share** step, the toolbar's **Share view…** button and the
**Admin → Shared Matrices** tab, and share links open for their recipients.

**Off** — all of those are hidden, and the API answers `404` on every share endpoint:
creating, listing and revoking shares, **and opening a link**. A recipient who opens
a link that was sent while sharing was on sees the same "This link doesn’t open a
shared view" page as for an unknown link — never an error.

### What the switch does *not* do

Turning it off **does not delete anything.** Existing shares, their recipients and
their usage history stay in the database; switching the flag back on makes every
link that was not revoked open again. To end a single share for good, revoke it
under **Admin → Shared Matrices** while the feature is on.

The permission still decides *who* may share: the flag decides whether sharing
exists on this install at all.

---

## Leaving experimental behind

The label is temporary by design. Once a feature has run against enough real
environments, one of two things happens:

- **It graduates.** The experimental flag is removed and it becomes an ordinary
  feature, always available. Existing configurations are untouched — the crawler
  simply stops being badged and stops needing the switch.
- **It is withdrawn.** If real-world use shows the approach does not hold up, the
  feature is removed rather than carried indefinitely. Anything being withdrawn is
  announced in the changelog first.

Either way, feedback from running one in anger is what moves it. If you are using an
experimental feature, [tell us how it went](../contributing/report-an-issue.md) —
that is exactly the mileage it is waiting for.
