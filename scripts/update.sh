#!/bin/sh
# Updates a Linedesk install to the newest release (the highest v* tag), then runs scripts/deploy.sh. Run it as the
# user that owns the checkout, in the checkout (cd /opt/linedesk && scripts/update.sh). Arguments go to deploy.sh.
#
# LINEDESK_REF=<tag or branch> updates to that instead, e.g. LINEDESK_REF=main for the newest commit on main (not a
# release: it may hold a change whose full tests run only after the merge).
set -eu
cd "$(dirname "$0")/.."

ref=${LINEDESK_REF:-$(git ls-remote --tags --refs --sort=-v:refname origin 'v*' | awk -F/ 'NR == 1 { print $3 }')}
[ -n "$ref" ] || ref=main
if git ls-remote --exit-code --tags origin "refs/tags/$ref" >/dev/null 2>&1; then
  git fetch --quiet --depth 1 origin tag "$ref"
  git -c advice.detachedHead=false checkout --quiet "refs/tags/$ref"
else
  git fetch --quiet --depth 1 origin "$ref"
  git -c advice.detachedHead=false checkout --quiet FETCH_HEAD
fi
echo "Linedesk $ref ($(git rev-parse --short HEAD))"
exec scripts/deploy.sh "$@"
