// The ratchet shared by the docs guards (retired vocabulary, links and anchors).
//
// Same idea as the file-length and complexity ratchets (.ci/*-baseline.json):
// what is wrong today is written down per page and may only shrink. Both guards
// measure the docs into the same shape —
//
//   { "<page>": { "<item>": <count> } }
//
// — where an item is a banned term or a broken link target. A count ABOVE its
// baseline (or an item or page the baseline does not know) is a regression and
// fails. A count BELOW it is an improvement and never fails: several people fix
// pages at once, and a guard that went red because a page got better would be
// switched off within a week.

const countOf = (measured, page, item) => measured[page]?.[item] ?? 0;

/**
 * Compare a fresh measurement with the committed baseline.
 * Returns the items that got worse and the ones that got better, each as
 * { page, item, was, now }, in page-then-item order.
 */
export function compare(current, baseline) {
  const regressions = [];
  const improvements = [];
  const pages = new Set([...Object.keys(current), ...Object.keys(baseline)]);
  for (const page of [...pages].sort()) {
    const items = new Set([
      ...Object.keys(current[page] ?? {}),
      ...Object.keys(baseline[page] ?? {}),
    ]);
    for (const item of [...items].sort()) {
      const was = countOf(baseline, page, item);
      const now = countOf(current, page, item);
      if (now > was) regressions.push({ page, item, was, now });
      else if (now < was) improvements.push({ page, item, was, now });
    }
  }
  return { regressions, improvements };
}

/**
 * The baseline to commit after a measurement. By default it only ratchets down:
 * every count becomes min(baseline, current), and what reached zero is dropped.
 * A regression is NOT absorbed — it keeps its old ceiling, so regenerating can
 * never quietly grandfather new debt. `allowIncrease` writes the measurement as
 * it is, for the first baseline or a deliberate, reviewed exception.
 */
export function tighten(current, baseline, { allowIncrease = false } = {}) {
  const out = {};
  for (const page of Object.keys(current).sort()) {
    for (const item of Object.keys(current[page]).sort()) {
      const now = current[page][item];
      const next = allowIncrease ? now : Math.min(now, countOf(baseline, page, item));
      if (next > 0) (out[page] ??= {})[item] = next;
    }
  }
  return out;
}

/** One line per finding, for the failure message. */
export function describe({ page, item, was, now }) {
  return `${page}: ${item} — ${now} now, ${was} allowed`;
}
