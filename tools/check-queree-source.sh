#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
. "$root/tools/queree-release-sources.lock"
directory=$(CDPATH= cd -- "$1" && pwd)
case "$2" in
    UASSETS_MAIN_COMMIT) expected=$UASSETS_MAIN_COMMIT; label='uAssets main'; archive='dist/build/uAssets/main' ;;
    UASSETS_PROD_COMMIT) expected=$UASSETS_PROD_COMMIT; label='uAssets production'; archive='dist/build/uAssets/prod' ;;
    OPENTECHALYZER_COMMIT) expected=$OPENTECHALYZER_COMMIT; label='OpenTechalyzer'; archive='third_party_sources/opentechalyzer' ;;
    WEBAPPANALYZER_COMMIT) expected=$WEBAPPANALYZER_COMMIT; label='WebAppAnalyzer'; archive='third_party_sources/webappanalyzer' ;;
    *) echo "Unknown source pin: $2" >&2; exit 1 ;;
esac
if [ -e "$directory/.git" ]; then
    [ "$(git -C "$directory" rev-parse HEAD)" = "$expected" ] || {
        echo "Wrong cached revision in $directory" >&2; exit 1;
    }
    [ -z "$(git -C "$directory" status --porcelain --untracked-files=all --ignored)" ] || {
        echo "Modified source cache: $directory" >&2; exit 1;
    }
    # Git status deliberately hides assume-unchanged/skip-worktree entries.
    if git -C "$directory" ls-files -v | grep -q '^[a-zS] '; then
        echo "Hidden source-cache changes cannot be verified: $directory" >&2; exit 1
    fi
else
    # Corresponding-source archives intentionally have no Git metadata.
    [ "$directory" = "$root/$archive" ] &&
        grep -Fxq "$label: $expected" "$root/SOURCE-MANIFEST.txt" || {
        echo "Missing pinned source checkout or release archive: $directory" >&2; exit 1;
    }
    python3 "$root/tools/check-queree-source-archive.py" "$root" "$directory"
fi
