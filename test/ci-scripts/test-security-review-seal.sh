#!/usr/bin/env bash
# Self-test for .github/scripts/security_review_seal.sh: a sealed file opens
# with the matching private key, the sealed artifact does not contain the
# plaintext, and the wrong key or a missing key fails instead of producing output.
#
# Usage: bash test/ci-scripts/test-security-review-seal.sh
set -euo pipefail

script="$(cd "$(dirname "$0")/../.." && pwd)/.github/scripts/security_review_seal.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; fail=1; fi; }

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$work/priv.pem" 2>/dev/null
openssl pkey -in "$work/priv.pem" -pubout -out "$work/pub.pem"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$work/other.pem" 2>/dev/null

printf '{"findings":[{"title":"UNFIXED-SECRET-MARKER"}]}\n' > "$work/findings.json"

SEAL_PUBLIC_KEY="$(cat "$work/pub.pem")" bash "$script" seal "$work/findings.json" "$work/sealed"
check "seal writes the encrypted file and the wrapped key" '[ -s "$work/sealed/findings.enc" ] && [ -s "$work/sealed/key.enc" ]'
check "the sealed artifact does not contain the plaintext" '! grep -rq "UNFIXED-SECRET-MARKER" "$work/sealed"'

SEAL_PRIVATE_KEY="$(cat "$work/priv.pem")" bash "$script" open "$work/sealed" "$work/opened.json"
check "open with the matching key restores the file exactly" 'cmp -s "$work/findings.json" "$work/opened.json"'

check "open with a different private key fails" '! SEAL_PRIVATE_KEY="$(cat "$work/other.pem")" bash "$script" open "$work/sealed" "$work/wrong.json" 2>/dev/null'
check "seal without a public key fails" '! env -u SEAL_PUBLIC_KEY bash "$script" seal "$work/findings.json" "$work/x" 2>/dev/null'
check "an unknown mode fails with usage" '! bash "$script" peek a b 2>/dev/null'

SEAL_PUBLIC_KEY="$(cat "$work/pub.pem")" bash "$script" seal "$work/findings.json" "$work/sealed2"
check "two seals of the same file differ (fresh key each time)" '! cmp -s "$work/sealed/findings.enc" "$work/sealed2/findings.enc"'

exit "$fail"
