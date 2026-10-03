#!/usr/bin/env bash
# Build the two portable Windows ZIPs every GitHub release ships, into
# app/api/dist-node-launcher/release/:
#
#   IdentityAtlas-portable.zip           PGlite only. node.exe is its only
#                                        executable and is code-signed, so the
#                                        zip passes publisher-based WDAC.
#   IdentityAtlas-portable-postgres.zip  Also embeds a real PostgreSQL 16 server
#                                        (--with-postgres) for large data sets.
#                                        Those binaries are NOT code-signed and
#                                        need VCRUNTIME140.dll, which is why this
#                                        is not the default.
#
# Usage (from the repo root, after `npm install` in app/desktop):
#   bash .github/scripts/build_portable_zips.sh
#
# Shared by cut-release.yml, cut-beta.yml and cut-hotfix.yml so the three cannot
# drift. The ordering below is the part that is easy to get wrong:
# build-node-launcher.mjs always writes dist-node-launcher/IdentityAtlas-portable.zip
# and deletes that file first, so the default zip has to be moved out of the way
# before the PostgreSQL build runs, or the second build silently destroys it.
# The second build reuses the UI the first one built (--skip-ui-build reads
# app/ui/dist, which the first build just wrote).
set -euo pipefail

cd "$(dirname "$0")/../../app/api"

DIST=dist-node-launcher
OUT="$DIST/release"
DEFAULT_ZIP="$OUT/IdentityAtlas-portable.zip"
POSTGRES_ZIP="$OUT/IdentityAtlas-portable-postgres.zip"

rm -rf "$OUT"
mkdir -p "$OUT"

echo "=== [1/2] Default portable ZIP (PGlite) ==="
npm run build:node-launcher
mv "$DIST/IdentityAtlas-portable.zip" "$DEFAULT_ZIP"

echo "=== [2/2] PostgreSQL portable ZIP (--with-postgres) ==="
node ../desktop/scripts/build-node-launcher.mjs --skip-ui-build --with-postgres
mv "$DIST/IdentityAtlas-portable.zip" "$POSTGRES_ZIP"

# Check each zip is the variant its name promises: a swapped or flag-dropped
# build would otherwise ship a "-postgres" zip that fails with "no postgres
# binaries found", or a default zip carrying unsigned executables.
has_postgres() {
  pwsh -NoProfile -NonInteractive -Command "
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    \$zip = [IO.Compression.ZipFile]::OpenRead('$1')
    try { if (\$zip.Entries | Where-Object { \$_.FullName -match '^postgres[/\\\\]bin[/\\\\]postgres\\.exe\$' }) { 'yes' } else { 'no' } }
    finally { \$zip.Dispose() }
  " | tr -d '\r'
}

if [ "$(has_postgres "$DEFAULT_ZIP")" != "no" ]; then
  echo "::error::$DEFAULT_ZIP contains postgres/bin/postgres.exe; the default zip must stay PGlite-only" >&2
  exit 1
fi
if [ "$(has_postgres "$POSTGRES_ZIP")" != "yes" ]; then
  echo "::error::$POSTGRES_ZIP has no postgres/bin/postgres.exe" >&2
  exit 1
fi

ls -l "$OUT"
