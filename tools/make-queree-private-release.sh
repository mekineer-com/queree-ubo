#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOCK="$ROOT/tools/queree-release-sources.lock"
ASSETS="$ROOT/dist/build/uAssets"
SOURCE_DEPS="$ROOT/dist/build/queree-release-sources"
RELEASES="$ROOT/dist/releases"

. "$LOCK"

commit=$(git -C "$ROOT" rev-parse HEAD)
[ -z "$(git -C "$ROOT" status --porcelain)" ] || {
    echo "Refusing to release a dirty worktree" >&2
    exit 1
}
version=$(cat "$ROOT/dist/version")
tag="queree-v$version"
exec 9>"$ROOT/dist/build/.queree-release.lock"
flock -n 9 || { echo 'Another private release is running' >&2; exit 1; }
if git -C "$ROOT" rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    echo "Release tag already exists: $tag" >&2
    exit 1
fi
"$ROOT/tools/check-queree-policy-revision.sh"
node "$ROOT/tools/check-queree-generated.mjs" --server-taxonomy \
    "${QUEREE_SERVER_TAXONOMY_MANIFEST:?Set QUEREE_SERVER_TAXONOMY_MANIFEST to the matching server taxonomy JSON manifest}" \
    "${QUEREE_SERVER_TAXONOMY_DATABASE:?Set QUEREE_SERVER_TAXONOMY_DATABASE to the matching server taxonomy SQLite database}"

sh "$ROOT/tools/check-queree-source.sh" "$ASSETS/main" UASSETS_MAIN_COMMIT
sh "$ROOT/tools/check-queree-source.sh" "$ASSETS/prod" UASSETS_PROD_COMMIT
sh "$ROOT/tools/check-queree-source.sh" "$SOURCE_DEPS/opentechalyzer" OPENTECHALYZER_COMMIT
sh "$ROOT/tools/check-queree-source.sh" "$SOURCE_DEPS/webappanalyzer" WEBAPPANALYZER_COMMIT

[ "$(git -C "$ROOT" rev-parse HEAD)" = "$commit" ] &&
    [ -z "$(git -C "$ROOT" status --porcelain)" ] || {
    echo 'Checkout changed during release validation' >&2; exit 1;
}
upstream_base=$(git -C "$ROOT" merge-base "$commit" upstream/master)
upstream_label=$(git -C "$ROOT" describe --tags --always "$upstream_base")
short_commit=$(git -C "$ROOT" rev-parse --short=9 "$commit")
release_name="quer-ee-${version}-${short_commit}"
release="$RELEASES/$release_name"
# The lock and missing completion tag make a SIGKILL orphan safe to retry.
if [ -d "$release" ]; then
    chmod -R u+w "$release"
    rm -rf "$release"
fi

# Stage on the release filesystem so publication is a directory rename.
mkdir -p "$RELEASES"
work=$(mktemp -d "$RELEASES/.queree-release.XXXXXX")
cleanup() {
    # A published directory without its completion tag is retryable, including
    # a signal between the final rename and tag creation.
    if [ -d "$release" ] && ! git -C "$ROOT" rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
        chmod -R u+w "$release"
        rm -rf "$release"
    fi
    chmod -R u+w "$work"
    rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
staged_release="$work/$release_name"
source_root="$work/$release_name-source"
mkdir -p "$source_root"
git -C "$ROOT" archive "$commit" | tar -x -C "$source_root"

mkdir -p "$source_root/dist/build/uAssets/main"
mkdir -p "$source_root/dist/build/uAssets/prod"
git -C "$ASSETS/main" archive "$UASSETS_MAIN_COMMIT" |
    tar -x -C "$source_root/dist/build/uAssets/main"
git -C "$ASSETS/prod" archive "$UASSETS_PROD_COMMIT" |
    tar -x -C "$source_root/dist/build/uAssets/prod"

mkdir -p "$source_root/third_party_sources/opentechalyzer"
mkdir -p "$source_root/third_party_sources/webappanalyzer"
git -C "$SOURCE_DEPS/opentechalyzer" archive "$OPENTECHALYZER_COMMIT" |
    tar -x -C "$source_root/third_party_sources/opentechalyzer"
git -C "$SOURCE_DEPS/webappanalyzer" archive "$WEBAPPANALYZER_COMMIT" \
    LICENSE README.md schema.json src/categories.json src/technologies |
    tar -x -C "$source_root/third_party_sources/webappanalyzer"

cat > "$source_root/SOURCE-MANIFEST.txt" <<EOF
Quer.ee commit: $commit
uBlock Origin base: $upstream_base ($upstream_label)
uAssets main: $UASSETS_MAIN_COMMIT
uAssets production: $UASSETS_PROD_COMMIT
OpenTechalyzer: $OPENTECHALYZER_COMMIT
WebAppAnalyzer: $WEBAPPANALYZER_COMMIT
AdGuard Base snapshot SHA-256: $(sha256sum "$source_root/assets/queree/adguard-ads.txt" | cut -d' ' -f1)
HaGeZi Pop-Up Ads snapshot SHA-256: $(sha256sum "$source_root/assets/queree/popupads.txt" | cut -d' ' -f1)
EasyList Spanish snapshot SHA-256: $(sha256sum "$source_root/assets/queree/easylist-spanish.txt" | cut -d' ' -f1)
EOF
SOURCE_ROOT="$source_root" node --input-type=module <<'EOF' >> "$source_root/SOURCE-MANIFEST.txt"
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = process.env.SOURCE_ROOT;
const path = resolve(root, 'src/js/queree/vendor/domain-index-data.js');
const data = (await import(`${pathToFileURL(path).href}?release`)).default;
for ( const [ category, sources ] of Object.entries(data.categories) ) {
    for ( const source of sources ) {
        if ( typeof source.license !== 'string' || source.license === '' ) {
            throw new Error(`Domain source has no license: ${source.name}`);
        }
        console.log(
            `Domain data: ${category} | ${source.name} | ` +
            `${source.license} | sha256:${source.sha256} | ` +
            source.source
        );
    }
}
const { affiliateLinkSources, promotionSources } = await import(pathToFileURL(
    resolve(root, 'src/js/queree/vendor/website-lists.js')
).href);
for ( const source of promotionSources ) {
    console.log(`URL data: ${source.name} | ${source.license} | sha256:${source.sha256} | ${source.source}`);
}
for ( const source of affiliateLinkSources ) {
    console.log(`Link data: ${source.name} | ${source.license} | sha256:${source.sha256} | ${source.source}`);
}
console.log('URL matcher: @ublacklist/match-pattern 2.0.0 | MIT | sha256:' +
    createHash('sha256').update(readFileSync(resolve(root,
        'src/js/queree/vendor/ublacklist/match-pattern.js'))).digest('hex'));
EOF

# Freeze corresponding source before any tests/builds. Gitless dependency checks
# compare against this ZIP just as they do when rebuilding a published release.
source_zip="$work/quer-ee-${version}-source.zip"
(cd "$work" && zip -qr "$source_zip" "$(basename "$source_root")")
(cd "$work" && sha256sum "$(basename "$source_zip")" > SHA256SUMS)

(cd "$source_root" && node tools/check-queree-generated.mjs)
(cd "$source_root" && npm test)
(cd "$source_root" && bash tools/make-firefox.sh all)
xpi="$source_root/dist/build/uBlock0.firefox.xpi"
python3 - "$xpi" "$version" "$source_root/LICENSE.txt" \
    "$source_root/THIRD_PARTY_NOTICES.txt" <<'PY'
import json
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    manifest = json.loads(archive.read("manifest.json"))
    if manifest.get("name") != "uBlock Origin + Quer.ee":
        raise SystemExit("XPI has wrong product name")
    if manifest.get("version") != sys.argv[2]:
        raise SystemExit("XPI has wrong version")
    identifier = manifest.get("browser_specific_settings", {}).get("gecko", {}).get("id")
    if identifier != "queree@mekineer.com":
        raise SystemExit("XPI has wrong extension ID")
    if archive.read("LICENSE.txt") != open(sys.argv[3], "rb").read():
        raise SystemExit("XPI GPL license differs from source")
    notices = open(sys.argv[4], "rb").read()
    if archive.read("THIRD_PARTY_NOTICES.txt") != notices:
        raise SystemExit("XPI third-party notices differ from source")
PY

mkdir -p "$staged_release"
cp "$xpi" "$staged_release/quer-ee-${version}-unsigned.xpi"
cp "$source_root/LICENSE.txt" "$staged_release/LICENSE.txt"
cp "$source_root/THIRD_PARTY_NOTICES.txt" "$staged_release/THIRD_PARTY_NOTICES.txt"
cp "$source_root/QUEREE_BUILDING.md" "$staged_release/BUILDING.md"
cp "$source_root/QUEREE_PRIVACY.md" "$staged_release/PRIVACY.md"
cp "$source_root/SOURCE-MANIFEST.txt" "$staged_release/SOURCE-MANIFEST.txt"
cat > "$staged_release/PRIVATE-UNSIGNED.txt" <<EOF
Private unsigned build. Do not publish or offer this XPI for normal installation.
Replace it with the AMO-signed XPI and verify that payload against this build.
EOF

cp "$source_zip" "$staged_release/"
(cd "$staged_release" && sha256sum \
    "quer-ee-${version}-unsigned.xpi" \
    "quer-ee-${version}-source.zip" \
    LICENSE.txt THIRD_PARTY_NOTICES.txt BUILDING.md PRIVACY.md \
    SOURCE-MANIFEST.txt > SHA256SUMS)
mv "$staged_release" "$release"
if ! chmod -R a-w "$release" || ! git -C "$ROOT" tag "$tag" "$commit"; then
    chmod -R u+w "$release"
    rm -rf "$release"
    exit 1
fi
echo "Private release created: $release"
