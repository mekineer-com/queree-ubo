#!/usr/bin/env bash
#
# This script assumes a linux environment

set -eu

DES=dist/build/uAssets
LOCK=tools/queree-release-sources.lock

. "$LOCK"

checkout_commit() {
    repository=$1
    commit=$2
    destination=$3
    git init -q "$destination"
    git -C "$destination" remote add origin "$repository"
    git -C "$destination" fetch -q --depth 1 origin "$commit"
    git -C "$destination" checkout -q --detach FETCH_HEAD
}

echo "*** Pull assets from remote into $DES"
checkout_commit "$UASSETS_REPOSITORY" "$UASSETS_MAIN_COMMIT" "$DES/main"
checkout_commit "$UASSETS_REPOSITORY" "$UASSETS_PROD_COMMIT" "$DES/prod"
