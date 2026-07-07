#!/usr/bin/env python3
"""Migration immutability gate - an already-applied migration must never change.

CLAUDE.md / app/api/CLAUDE.md rule: "add a new file for each schema change - never
edit existing migration files." The migration runner (app/api/src/db/migrate.js)
tracks applied files by filename only, with NO content checksum, so a silent edit
to an applied migration would never re-run and would leave environments diverged.

This gate records a content hash of every `*.sql` in app/api/src/db/migrations/ in
a committed baseline (.ci/migration-hashes.json) and fails if a recorded file's
content changes or is deleted. Hashes are over newline-normalised UTF-8, so a
CRLF/LF checkout difference between Windows and the Linux CI runner never trips it.

`--update` is ADDITIVE-ONLY: it records hashes for NEW migration files but never
rewrites or removes an existing entry - so the gate can't be laundered by editing
a migration and re-baselining. Migrations are append-only; so is this baseline.

Usage:
  python tools/migrations/ratchet.py            # check (CI)
  python tools/migrations/ratchet.py --update   # record hashes for NEW migrations

Mirrors the other ratchets (tools/filesize, tools/complexity, tools/node-version):
pure logic in evaluate()/update_baseline() is unit-tested before it gates.
"""
import argparse
import hashlib
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MIG_DIR = os.path.join(REPO, "app", "api", "src", "db", "migrations")
BASELINE = os.path.join(REPO, ".ci", "migration-hashes.json")


def hash_text(text):
    """SHA-256 of newline-normalised UTF-8 - platform/line-ending independent."""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def measure():
    out = {}
    for name in sorted(os.listdir(MIG_DIR)):
        if name.endswith(".sql"):
            with open(os.path.join(MIG_DIR, name), encoding="utf-8", newline="") as f:
                out[name] = hash_text(f.read())
    return out


def load_baseline():
    if not os.path.exists(BASELINE):
        return {}
    with open(BASELINE, encoding="utf-8") as f:
        return json.load(f).get("files", {})


def evaluate(current, baseline):
    """Pure gate logic. current/baseline = {filename: hash}. Returns violations."""
    fails = []
    for name in sorted(baseline):
        if name not in current:
            fails.append(f"{name}: an applied migration was DELETED. Migrations are "
                         f"immutable and append-only - never remove one.")
        elif current[name] != baseline[name]:
            fails.append(f"{name}: an applied migration was EDITED (content hash changed). "
                         f"Migrations are immutable - add a NEW migration file instead of "
                         f"changing this one. (If it was genuinely never deployed, change its "
                         f"line in .ci/migration-hashes.json in a separate, explained commit.)")
    for name in sorted(current):
        if name not in baseline:
            fails.append(f"{name}: new migration not recorded. Finalize it, then run: "
                         f"python tools/migrations/ratchet.py --update")
    return fails


def update_baseline(baseline, current):
    """Additive-only: add NEW files; never rewrite or drop an existing entry."""
    merged = dict(baseline)
    added = [n for n in sorted(current) if n not in merged]
    for n in added:
        merged[n] = current[n]
    return merged, added


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--update", action="store_true",
                    help="record hashes for NEW migrations (additive-only)")
    args = ap.parse_args()

    current = measure()
    baseline = load_baseline()

    if args.update:
        merged, added = update_baseline(baseline, current)
        os.makedirs(os.path.dirname(BASELINE), exist_ok=True)
        with open(BASELINE, "w", encoding="utf-8") as f:
            json.dump({
                "_comment": ("Immutable content hashes of applied SQL migrations. Additive-only: "
                             "adding a migration appends a line; existing lines never change. "
                             "Regenerate new entries with: python tools/migrations/ratchet.py --update"),
                "algorithm": "sha256 of newline-normalised utf-8",
                "files": dict(sorted(merged.items())),
            }, f, indent=2)
            f.write("\n")
        print(f"Recorded {len(added)} new migration(s); baseline has {len(merged)} total.")
        for n in added:
            print(f"  + {n}")
        return 0

    fails = evaluate(current, baseline)
    print(f"[migrations] {len(current)} migration(s); {len(baseline)} recorded as immutable.")
    if fails:
        print(f"Migration immutability gate FAILED: {len(fails)} violation(s).")
        for msg in fails:
            print(f"::error::Migration immutability: {msg}")
        return 1
    print("Migration immutability gate OK - no applied migration changed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
