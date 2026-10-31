#!/usr/bin/env bash
# Runs on the server, from the archive `bun run deploy` (scripts/deploy.ts) unpacks beside it:
# the built site (public/).
#
# The site unpacks into a release directory of its own and goes live by renaming
# a symlink over `current`, the directory the web server serves
# candorlanguage.org from. Caddy follows the link on every request, so it needs no
# reload. The last five releases stay, for rolling back by hand:
#
#   ln -sfn /var/www/candorlanguage/releases/<older> /var/www/candorlanguage/current
set -euo pipefail

bundle="$(cd "$(dirname "$0")" && pwd)"
root=/var/www/candorlanguage
release="$root/releases/$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$root/releases"
mv "$bundle/public" "$release"
# Set, not added to: Windows' tar records every file as 666 and every directory
# as 777, and those would arrive world-writable.
chmod -R u=rwX,go=rX "$release"

ln -sfn "$release" "$root/current.next"
mv -T "$root/current.next" "$root/current"

ls -1d "$root"/releases/* | sort | head -n -5 | xargs -r rm -rf
rm -rf "$bundle"
echo "Live: $release"
