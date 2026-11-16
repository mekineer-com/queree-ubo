#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOCK="$ROOT/tools/queree-release-sources.lock"
DES="$ROOT/dist/build/queree-release-sources"

. "$LOCK"

mkdir -p "$DES"
exec 9>"$DES/.pull.lock"
flock 9
temporary=
trap '[ -z "$temporary" ] || rm -rf "$temporary"' EXIT
trap 'exit 1' HUP INT TERM

checkout_commit() {
    repository=$1
    commit=$2
    destination=$3
    if [ -e "$destination/.git" ]; then
        sh "$ROOT/tools/check-queree-source.sh" "$destination" "$4"
        return
    fi
    [ ! -e "$destination" ] || {
        echo "Refusing non-Git source cache: $destination" >&2
        exit 1
    }
    temporary=$(mktemp -d "$DES/.checkout.XXXXXX")
    git init -q "$temporary"
    git -C "$temporary" remote add origin "$repository"
    git -C "$temporary" fetch -q --depth 1 origin "$commit"
    git -C "$temporary" checkout -q --detach FETCH_HEAD
    mv "$temporary" "$destination"
    temporary=
}

checkout_commit \
    "$OPENTECHALYZER_REPOSITORY" "$OPENTECHALYZER_COMMIT" \
    "$DES/opentechalyzer" OPENTECHALYZER_COMMIT
checkout_commit \
    "$WEBAPPANALYZER_REPOSITORY" "$WEBAPPANALYZER_COMMIT" \
    "$DES/webappanalyzer" WEBAPPANALYZER_COMMIT

echo "Pinned release sources are ready in $DES"
