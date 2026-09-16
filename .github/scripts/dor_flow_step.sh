#!/usr/bin/env bash
# Run one DoR flow step and tell the workflow whether it needs a fresh BOT token to go on.
#
# A flow that checkpointed (dor_token_checkpoint.sh) exits DOR_NEEDS_TOKEN_RC. That is not a failure:
# the step succeeds and sets `needs-token=true`, which is what the workflow's next token-refresh slot
# runs on. Any other exit is passed through unchanged, so bail (1) still fails the step and trips the
# Exceptions backstop exactly as before. The code alone is not trusted — a checkpoint file must exist
# too, so an unrelated exit that happens to be 75 cannot masquerade as a hand-over.
#
#   Usage: dor_flow_step.sh <flow script in this directory>   (env as that flow expects)
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=dor_token_checkpoint.sh
source "$here/dor_token_checkpoint.sh"

bash "$here/${1:?usage: dor_flow_step.sh <flow script>}"; rc=$?
if [ "$rc" -eq "$DOR_NEEDS_TOKEN_RC" ] && [ -f "$(dor_checkpoint_file)" ]; then
  echo "needs-token=true" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "::notice::the flow checkpointed for a fresh BOT token — the next token-refresh step continues it"
  exit 0
fi
exit "$rc"
