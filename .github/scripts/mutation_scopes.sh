#!/usr/bin/env bash
# Prints the JavaScript mutation matrix as compact JSON — one entry per Stryker
# config in a package root:
#   [{"pkg":"api","name":"auth","label":"API auth","config":"stryker.auth.config.json"}, ...]
#
# Derived, not listed, for the same reason tools/mutation/stryker_to_mutation_json.py
# derives the reports it requires: the weekly workflow once listed 9 scopes by hand
# while 21 configs existed, so the publish step (which demands a report per config)
# failed every week and the scores on the docs page went stale without anyone
# noticing. Adding a stryker.<name>.config.json now adds it to the run.
#
# Usage: mutation_scopes.sh [repo-root]   (default: current directory)
set -euo pipefail

root="${1:-.}"
first=1
printf '['
for pkg in api ui; do
  for cfg in "$root"/app/"$pkg"/stryker.*.config.json; do
    [ -e "$cfg" ] || continue
    file="$(basename "$cfg")"
    name="${file#stryker.}"; name="${name%.config.json}"
    case "$name" in
      *[!a-z0-9-]*|'') echo "mutation_scopes.sh: unexpected config name '$file'" >&2; exit 2 ;;
    esac
    label="$(printf '%s' "$pkg" | tr '[:lower:]' '[:upper:]') $name"
    [ "$first" = 1 ] || printf ','
    first=0
    printf '{"pkg":"%s","name":"%s","label":"%s","config":"%s"}' "$pkg" "$name" "$label" "$file"
  done
done
printf ']\n'
