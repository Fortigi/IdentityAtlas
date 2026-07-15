# Contribute a change

Identity Atlas is open source, and changes from outside the core team are
welcome — whether that's fixing a typo in these docs or adding a whole feature.
This page explains how, starting from the easiest path.

You contribute by opening a **pull request** (PR): a proposal that says
*"here are my changes, please include them."* The team reviews it, and once it's
approved it becomes part of the product. Nothing you propose goes live on its
own — every PR is reviewed first.

!!! tip "Just want to report a problem or suggest an idea?"
    You don't need to make the change yourself. See
    **[Report a bug or request a feature](report-an-issue.md)** — that's often
    the right first step.

## The easiest change: edit a page in your browser

Every page on this documentation site has an **edit pencil** (:material-pencil:)
near the top right. You don't need to install anything.

1. Click the pencil on the page you want to improve.
2. GitHub opens the page's text in an editor. Make your change.
3. Click **Commit changes…**, keep *"Create a new branch and start a pull
   request"* selected, and confirm.

That's it — you've opened a pull request. GitHub automatically makes your own
copy (a "fork") behind the scenes; you don't have to think about it.

This is the whole flow for fixing typos, clarifying wording, or correcting a
link — no developer tools required.

## Changing code

Code changes follow the same idea but need a few tools on your computer. The
short version:

1. **Fork** the [repository :material-open-in-new:](https://github.com/Fortigi/IdentityAtlas){ target=_blank rel=noopener }
   (the *Fork* button, top right) — this makes your own copy.
2. **Create a branch** off `main` for your change. Use a descriptive name like
   `feature/my-idea` or `bugfixes/fix-that-thing`.
3. **Make your change** and test it against the running app. See
   [Local Development](../ui/local-dev.md) to get the stack running.
4. **Add a changelog note** — a short bullet describing the change, in a new
   file under `changes/` (name it after your branch). Don't edit `CHANGES.md`
   directly; it's assembled automatically.
5. **Open a pull request** into `main` and describe what you changed and why.

The team reviews every PR, and automated checks run on it (tests, linting,
coverage). A maintainer approves and merges it.

!!! info "Good to know before you dive into code"
    - **One change per branch** — keep each pull request focused on a single
      fix or feature. It's much easier to review.
    - **Tests come with the change** — new or changed code ships with tests that
      cover it. Our checks won't let overall test coverage drop.
    - Deeper conventions live in the **[UI Style Guide](style-guide.md)** and the
      **[CI Pipeline](ci-pipeline.md)** pages.

## Not sure where to start?

Open an [issue](report-an-issue.md) describing what you'd like to do, or comment
on an existing one to say you'd like to take it. We're happy to point you in the
right direction before you write any code.
