// What the monthly reviews share about the findings file a model writes: the
// security review (this directory) and the docs audit (../docsReview/). Each
// review defines its own fields and numbering; the checks and the start of each
// CLI command are the same, so they live here once.

// A finding's stable identity across months: the filing marker hashes it.
export const FINGERPRINT = /^[a-z0-9][a-z0-9._:/-]{5,119}$/;

/** Problems with the required text fields of one finding. `fields` = [[name, maximum length]]. */
export function textProblems(f, where, fields) {
  const problems = [];
  for (const [field, max] of fields) {
    const v = f[field];
    if (typeof v !== 'string' || v.trim() === '') problems.push(`${where}: ${field} is required`);
    else if (v.length > max) problems.push(`${where}: ${field} is longer than ${max} characters`);
  }
  return problems;
}

/** One problem per fingerprint that appears more than once: one filing would track two problems. */
export function duplicateProblems(findings) {
  const seen = new Set();
  const problems = [];
  for (const f of findings) {
    if (seen.has(f.fingerprint)) problems.push(`fingerprint ${f.fingerprint} appears twice`);
    seen.add(f.fingerprint);
  }
  return problems;
}

function load(path, deps, validate) {
  let parsed;
  try {
    parsed = JSON.parse(deps.readFile(path));
  } catch (err) {
    return { ok: false, problems: [`${path} is not readable JSON: ${err.message}`] };
  }
  return validate(parsed);
}

/**
 * The common start of `cli.js <command> <findings.json> ...`: check the command,
 * load and validate the file, and finish `validate` outright.
 * Returns { exit } when the command is done (2 usage, 1 invalid, 0 valid), or
 * { command, report, args } with the validated report and the remaining arguments.
 */
export function openCommand(argv, deps, { commands, usage, validate }) {
  const [command, findingsPath, ...args] = argv;
  if (!commands.includes(command) || !findingsPath) {
    deps.log(usage);
    return { exit: 2 };
  }
  const result = load(findingsPath, deps, validate);
  if (!result.ok) {
    result.problems.forEach(p => deps.log(`invalid: ${p}`));
    return { exit: 1 };
  }
  if (command === 'validate') {
    deps.log(`${findingsPath} is valid: ${result.report.findings.length} findings`);
    return { exit: 0 };
  }
  return { command, report: result.report, args };
}
