#!/usr/bin/env bash
# Test-secret visibility gate for pr-integration.yml (audit F2).
#
# The Entra-crawler and LLM risk-scoring suites run only when their secret is
# set; when it isn't they skip and the job still records a PASS. This reports
# which suites will skip (run summary + warning annotations) and, when
# ENFORCE=true, fails instead.
#
# Enforcement is skipped when the run received NO repository secrets at all,
# which is decided by one canary rather than by listing who gets no secrets.
# That set is not ours to enumerate: forks get none, Dependabot runs get only
# Dependabot secrets (seen on #1532), and GitHub may add more such cases. A
# missing TEST_* secret is a misconfiguration only when the run could have
# received it, i.e. when an always-present secret did arrive.
#
#   SECRETS_REACHED  'true' when the always-present canary secret (BOT_APP_ID,
#                    which every release workflow needs) reached this run
#   ENFORCE          vars.ENFORCE_TEST_SECRETS
#   TEST_GRAPH_TENANT_ID TEST_GRAPH_CLIENT_ID TEST_GRAPH_CLIENT_SECRET
#   TEST_LLM_API_KEY the secrets being checked
#
# Writes to $GITHUB_STEP_SUMMARY (default /dev/null). Exit 0 = report only,
# 1 = enforced and something is missing.
set -euo pipefail

summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
required=(TEST_GRAPH_TENANT_ID TEST_GRAPH_CLIENT_ID TEST_GRAPH_CLIENT_SECRET TEST_LLM_API_KEY)

if [ "${SECRETS_REACHED:-}" != "true" ]; then
  echo "This run received no repository secrets (fork or Dependabot PR) — the Entra/LLM suites will skip. Not enforced." >> "$summary"
  exit 0
fi

missing=()
for s in "${required[@]}"; do
  if [ -z "${!s:-}" ]; then missing+=("$s"); fi
done

if [ ${#missing[@]} -eq 0 ]; then
  echo "✅ All required test secrets are present — the Entra/LLM suites will run." >> "$summary"
  exit 0
fi

{
  echo "## ⚠️ Missing test secrets — some suites will skip"
  echo
  echo "These suites record a PASS **without running** because their secret is unset:"
  for s in "${missing[@]}"; do echo "- \`$s\`"; done
  echo
  echo "Add them under **Settings → Secrets and variables → Actions** to exercise the Entra-crawler and LLM risk-scoring paths on \`main\` PRs."
} >> "$summary"
for s in "${missing[@]}"; do
  echo "::warning title=Missing test secret::${s} is unset — its test suite will skip silently"
done

if [ "${ENFORCE:-}" = "true" ]; then
  echo "::error::ENFORCE_TEST_SECRETS=true and ${#missing[@]} required secret(s) missing — failing so the gap is caught, not skipped."
  exit 1
fi
echo >> "$summary"
echo "_Set repository variable \`ENFORCE_TEST_SECRETS=true\` to make this a hard failure once secrets are configured._" >> "$summary"
