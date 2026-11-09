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
#   ONLY=api-auth,ui-pilot   keep just these scopes (<pkg>-<name>), for a manual
#                            dispatch that re-measures a few. An unknown name is an
#                            error, so a typo can't silently measure nothing.
set -euo pipefail

root="${1:-.}"
only="${ONLY:-}"; only="${only// /}"
entries=()
seen=","
for pkg in api ui; do
  for cfg in "$root"/app/"$pkg"/stryker.*.config.json; do
    [ -e "$cfg" ] || continue
    file="$(basename "$cfg")"
    name="${file#stryker.}"; name="${name%.config.json}"
    case "$name" in
      *[!a-z0-9-]*|'') echo "mutation_scopes.sh: unexpected config name '$file'" >&2; exit 2 ;;
    esac
    seen="$seen$pkg-$name,"
    if [ -n "$only" ]; then
      case ",$only," in *",$pkg-$name,"*) ;; *) continue ;; esac
    fi
    label="$(printf '%s' "$pkg" | tr '[:lower:]' '[:upper:]') $name"
    entries+=("$(printf '{"pkg":"%s","name":"%s","label":"%s","config":"%s"}' "$pkg" "$name" "$label" "$file")")
  done
done

if [ -n "$only" ]; then
  IFS=',' read -ra wanted <<<"$only"
  for w in "${wanted[@]}"; do
    [ -n "$w" ] || continue
    if [[ "$seen" != *",$w,"* ]]; then
      echo "mutation_scopes.sh: no scope '$w' (expected <pkg>-<name>, e.g. api-auth)" >&2; exit 2
    fi
  done
fi

( IFS=','; printf '[%s]\n' "${entries[*]:-}" )
