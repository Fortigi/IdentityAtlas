---
type: task
prereq: ui/contexts.md
outcome: You can build a context by describing what it is about — keeping the search terms that find the right groups, including or excluding individual ones — and it keeps itself up to date after every crawl.
---

# Building a context by describing it

!!! note "Experimental"
    The context assistant is off until an operator switches it on under
    **Admin → Experimental**. The "describe it" half also needs the optional
    [report generator](../reference/report-generator.md) container — the same one custom reports
    use. Everything else works without it: you type the search terms yourself.

Some contexts are not in the data. Nothing records which groups belong to *the purchasing process*
or *to HAMIS* — but the names and descriptions of those groups almost always say so. The context
assistant is built on that: you describe the subject, the search terms are proposed, and you decide
which of them really find what you mean.

You need the **Build contexts** permission (`data.write.contexts`).

## The short version

**Contexts → New context tree → Describe it** opens the context builder in its own tab.

1. **Describe it.** Type what the context is about — *"alle groepen rond het inkoopproces"*,
   *"everything to do with our DevOps projects"*. The model proposes search terms. It may ask one
   question back if your description names no subject at all.
2. **Check the terms.** Each term shows how many groups it finds, how many *only* it finds, and
   whether it matched the name or the description. Tick the ones that fit; untick the rest.
3. **Check the result.** The table lists every group the terms found, and why. Exclude one that
   does not belong; include one by name that no term finds.
4. **Create the context.** Give it a name and press **Create context**.

## What the model does, and what it does not

The model never sees your groups. It receives your description and answers with words — the same
division of labour as custom reports, where it writes *"name is Wim"* and Identity Atlas does the
looking up. Searching, counting and deciding membership are done by Identity Atlas, on your data.

**Only terms containing your own words start ticked.** If you ask about *inkoop*, then `inkoop`,
`inkoopproces` and `inkooporder` arrive ticked. Everything else the model adds — translations,
synonyms, system names — arrives **unticked**, marked *suggested*, with its numbers next to it. Tick
what fits.

This matters most for a name the model does not know. Asked about HAMIS it will happily suggest
`zorg`, `huisarts` and `medische zorg`, having decided HAMIS is about health care. Unticked, that
costs you a glance. Ticked by default, it would have quietly filled your context with every care
group. If you do tick suggestions and they bring in far more groups than your own words did, the
builder says so.

## Finding the words your organisation actually uses

A model cannot know that your DevOps groups are called `VSTS-…`, or that HAMIS groups also say
`HMS`. Your data can. **Find related words** looks at the groups already in the context and offers
the words that are unusually common in their names compared with all groups. Each suggestion says
how many groups in the context contain it and how many outside — click one to add it as a term.

## How a term matches

| Setting | Finds `inkoop` in | Not in |
|---|---|---|
| word starts with (default) | `SG_INKOOP_Users`, `Inkoopfacturen` | `Herinkoop` |
| whole word | `SG_INKOOP_Users` | `Inkoopfacturen` |
| anywhere | all of them | — |

Short terms and abbreviations default to **whole word**, which is what makes `INK` usable without
also finding every `link`. Upper and lower case never matter, and neither do `-`, `_` or `.`.

## Settings

- **Structure** — *a child context per term* shows why each group is in the context, and filtering
  the matrix on the top of the tree includes all of them. *One context* is a single flat list.
- **Search in** — name, description, mail address.
- **Kinds of object** — groups by default; any resource type your deployment holds.

## Keeping it up to date

The context refreshes itself after every crawl, from the terms and choices you saved. A new group
whose name matches a kept term joins it; a group you excluded stays out; a group you added by hand
stays in. The model is not involved in that, so the context keeps working whether or not the
generator container is running.

To change it later, open the context and press **Edit search terms**: the builder opens with the
same terms and choices, and saving refreshes that tree in place — your renames and any sub-context
you grafted under it are kept.

## When there is no model

If the generator is not deployed or not reachable, the builder says so and everything else works:
type the terms yourself, use **Find related words**, check the result, save. The assistant makes the
first draft quicker; it is not what makes the context.
