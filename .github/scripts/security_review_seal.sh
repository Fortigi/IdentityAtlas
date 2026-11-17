#!/usr/bin/env bash
# Seals the monthly security review's findings for the hand-over between jobs.
#
# The review job (model, no secrets) hands its findings to the filing job
# (GitHub App key, no model) as a workflow artifact. Artifacts of a public
# repository can be downloaded by anyone signed in to GitHub, and the findings
# hold unfixed vulnerabilities, so the artifact is encrypted.
#
# Asymmetric on purpose: the review job holds only the PUBLIC key (a repository
# variable), so nothing the model does in that job can decrypt the findings or
# steal a key that could. The private key exists only as a secret of the
# `security-review` environment, which only the filing job enters.
#
# Hybrid scheme with tools every runner has (openssl): a random 256-bit key
# encrypts the file (AES-256-CBC + PBKDF2), and RSA-OAEP encrypts that key.
#
# Usage:
#   security_review_seal.sh seal <in-file> <out-dir>   public key PEM in $SEAL_PUBLIC_KEY
#   security_review_seal.sh open <in-dir> <out-file>   private key PEM in $SEAL_PRIVATE_KEY
set -euo pipefail

mode="${1:?usage: security_review_seal.sh seal|open <in> <out>}"
in="${2:?missing input}"
out="${3:?missing output}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
umask 077

case "$mode" in
  seal)
    : "${SEAL_PUBLIC_KEY:?SEAL_PUBLIC_KEY must hold the public key PEM}"
    printf '%s\n' "$SEAL_PUBLIC_KEY" > "$work/pub.pem"
    mkdir -p "$out"
    openssl rand -hex 32 > "$work/key"
    openssl enc -aes-256-cbc -pbkdf2 -salt -in "$in" -out "$out/findings.enc" -pass stdin < "$work/key"
    openssl pkeyutl -encrypt -pubin -inkey "$work/pub.pem" -pkeyopt rsa_padding_mode:oaep \
      -pkeyopt rsa_oaep_md:sha256 -in "$work/key" -out "$out/key.enc"
    ;;
  open)
    : "${SEAL_PRIVATE_KEY:?SEAL_PRIVATE_KEY must hold the private key PEM}"
    printf '%s\n' "$SEAL_PRIVATE_KEY" > "$work/priv.pem"
    openssl pkeyutl -decrypt -inkey "$work/priv.pem" -pkeyopt rsa_padding_mode:oaep \
      -pkeyopt rsa_oaep_md:sha256 -in "$in/key.enc" -out "$work/key"
    openssl enc -d -aes-256-cbc -pbkdf2 -in "$in/findings.enc" -out "$out" -pass stdin < "$work/key"
    ;;
  *)
    echo "usage: security_review_seal.sh seal|open <in> <out>" >&2
    exit 2
    ;;
esac
