# Marketing & Press Kit

A self-contained, public-safe set of materials for talking about Identity Atlas —
slides, blog posts, conference abstracts, social copy, landing-page text.

This kit is the **messaging spine**: it sets the voice, the positioning, and the
claims we're comfortable making in public. The rest of the documentation is the
**fact-checking backbone** — when you need an exact detail (supported systems,
how IST/SOLL works, the scoring layers), follow the links into the reference docs.

## Why this exists

The full documentation is written to help someone *operate* Identity Atlas. It
answers "how does X work." Marketing needs the opposite altitude — the problem,
the stakes, the "so what," and a memorable through-line. These files carry that
register so promotional content comes out grounded and on-message instead of
reading like a reference manual.

## How to use it with Claude (Cowork / Claude Code)

Point the assistant at **this folder** (`docs/marketing/`) as its primary source,
and at the wider docs as a fact-check reference. The kit is small and opinionated
on purpose — it keeps the assistant from drowning in implementation detail and
keeps the messaging consistent across everything it produces.

Good prompts to start from:

- "Draft a 6-slide deck introducing Identity Atlas to a security-team audience, using `key-messages.md` and `use-cases.md`."
- "Write a 700-word launch blog post leading with the multi-system angle from `product-brief.md`."
- "Turn `founder-story.md` into a LinkedIn post in the first person."

## Contents

| File | What it's for |
|------|---------------|
| [Product Brief](product-brief.md) | The pitch, the problem, who it's for — start here |
| [Key Messages](key-messages.md) | Reusable value-prop statements and the "what you can do with it" list |
| [Features](features.md) | The four pillars, in benefit language |
| [Use Cases](use-cases.md) | Concrete scenarios to anchor stories and demos |
| [Proof Points](proof-points.md) | The credibility list — open source, local-first, one-click Azure, etc. |
| [Founder Story](founder-story.md) | The personal back-story behind the product |
| [FAQ](faq.md) | Common questions, with public-safe answers |
| [Boilerplate](boilerplate.md) | About-Fortigi paragraph, links, license, the one-liner |

## Guardrails

- **Don't over-promise the LLM scoring.** Layers 3 and 4 of the engine are still
  partial — see [History](../history.md). Describe what ships today.
- **Lead with "no identity data leaves your environment."** It's true and it's a
  differentiator; keep it accurate (the LLM sees *public* org context only).
- **Everything here is public-safe.** No credentials, no internal hostnames, no
  customer names. If a claim needs a source, link into the docs.
