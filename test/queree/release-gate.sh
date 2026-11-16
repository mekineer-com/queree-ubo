#!/bin/sh
set -eu

watched_paths=$(tools/check-queree-policy-revision.sh --watched-paths)
repository=$(git rev-parse --show-toplevel 2>/dev/null || :)
for path in $watched_paths; do
    if [ "$repository" = "$(pwd -P)" ]; then
        git ls-files --error-unmatch -- "$path" >/dev/null
    else
        # Release source archives deliberately contain no Git metadata.
        [ -e "$path" ] || { echo "Missing watched path: $path" >&2; exit 1; }
    fi
done

work=$(mktemp -d /tmp/queree-release-gate.XXXXXX)
cleanup() { chmod -R u+w "$work"; find "$work" -depth -delete; }
trap cleanup EXIT HUP INT TERM

mkdir -p "$work/tools" "$work/src/js/queree" "$work/dist"
cp tools/check-queree-policy-revision.sh "$work/tools/"
cat >"$work/src/js/queree/policy.js" <<'EOF'
export const decisionPolicyRevision = 'queree-policy-1';
EOF
printf '2.2.8\n' >"$work/dist/version"
git -C "$work" init -q
git -C "$work" config user.name test
git -C "$work" config user.email test@example.invalid
git -C "$work" add .
git -C "$work" commit -qm baseline

expect_failure() {
    expected=$1
    if output=$("$work/tools/check-queree-policy-revision.sh" 2>&1); then
        echo "Gate accepted: $expected" >&2
        exit 1
    fi
    printf '%s\n' "$output" | grep -q "$expected"
}

# An old environment setting must not bypass the actual release baseline.
export QUEREE_PREVIOUS_RELEASE=FIRST_RELEASE
expect_failure 'Missing completed release baseline'
git -C "$work" tag queree-v2.2.8
expect_failure 'version must increase'
printf '2.2.7\n' >"$work/dist/version"
expect_failure 'version must increase'
printf '2.2.x\n' >"$work/dist/version"
expect_failure 'Invalid release version'
printf '2.2.9\n' >"$work/dist/version"
printf 'documentation\n' >"$work/README.md"
git -C "$work" add .
git -C "$work" commit -qm documentation
"$work/tools/check-queree-policy-revision.sh"

printf 'settings UI\n' >"$work/src/queree.html"
git -C "$work" add .
git -C "$work" commit -qm ui
"$work/tools/check-queree-policy-revision.sh"

# Keep representative inputs independent of the gate's list, so deleting a
# required watch still fails. Removing fixtures keeps later checks independent.
for path in \
    assets/assets.json \
    assets/queree/adult-lists/domains.txt \
    assets/queree/website-lists/urls.txt \
    src/js/queree/controller.js \
    src/js/arglist-parser.js \
    src/js/assets.js \
    src/js/background.js \
    src/js/biditrie.js \
    src/js/cachestorage.js \
    src/js/filtering-context.js \
    src/js/hntrie.js \
    src/js/jsonpath.js \
    src/js/messaging.js \
    src/js/regex-analyzer.js \
    src/js/resources/scriptlets.js \
    src/js/s14e-serializer.js \
    src/js/scriptlet-filtering.js \
    src/js/static-filtering-io.js \
    src/js/static-filtering-parser.js \
    src/js/static-net-filtering.js \
    src/js/strict-blocking.js \
    src/js/start.js \
    src/js/storage.js \
    src/js/tab.js \
    src/js/tasks.js \
    src/js/text-utils.js \
    src/js/traffic.js \
    src/js/trusted-tokens.js \
    src/js/uri-utils.js \
    src/js/urlskip.js \
    src/lib/csstree/css-tree.js \
    src/lib/publicsuffixlist/publicsuffixlist.js \
    src/lib/punycode.js \
    src/lib/regexanalyzer/regex.js \
    src/background.html \
    src/queree-engine.html \
    platform/firefox/manifest.json \
    platform/common/vapi-common.js \
    platform/common/vapi-background.js \
    platform/firefox/vapi-background-ext.js \
    platform/firefox/webext.js \
    tools/copy-common-files.sh \
    tools/make-assets.sh \
    tools/make-firefox-meta.py \
    tools/make-firefox.sh \
    tools/queree-release-sources.lock
do
    mkdir -p "$work/$(dirname "$path")"
    printf 'verdict input\n' >"$work/$path"
    git -C "$work" add .
    git -C "$work" commit -qm "change $path"
    output=$("$work/tools/check-queree-policy-revision.sh")
    printf '%s\n' "$output" | grep -q 'Policy revision unchanged; confirm saved decisions remain compatible:'
    printf '%s\n' "$output" | grep -Fq "$path"
    rm "$work/$path"
    git -C "$work" add .
    git -C "$work" commit -qm "remove $path fixture"
done

# Retired worker tooling and the browser-test driver do not define verdicts.
for path in tools/queree-inspect.mjs tools/queree-webdriver.mjs; do
    printf 'test tooling\n' >"$work/$path"
    git -C "$work" add .
    git -C "$work" commit -qm "change $path"
    "$work/tools/check-queree-policy-revision.sh"
    rm "$work/$path"
    git -C "$work" add .
    git -C "$work" commit -qm "remove $path fixture"
    "$work/tools/check-queree-policy-revision.sh"
done

for snapshot in adguard-ads.txt popupads.txt easylist-spanish.txt; do
    printf 'refreshed ad snapshot\n' >"$work/assets/queree/$snapshot"
done
git -C "$work" add .
git -C "$work" commit -qm snapshots
"$work/tools/check-queree-policy-revision.sh"

printf 'verdict logic\n' >"$work/src/js/queree/controller.js"
git -C "$work" add .
git -C "$work" commit -qm logic
"$work/tools/check-queree-policy-revision.sh"

sed -i "s/queree-policy-1/queree-policy-2/" "$work/src/js/queree/policy.js"
git -C "$work" add .
git -C "$work" commit -qm revision
"$work/tools/check-queree-policy-revision.sh"
git -C "$work" tag -a -m completed-release queree-v2.2.9
printf '2.2.10\n' >"$work/dist/version"
printf 'new verdict logic\n' >>"$work/src/js/queree/controller.js"
git -C "$work" add .
git -C "$work" commit -qm next-release
"$work/tools/check-queree-policy-revision.sh"
for revision in queree-policy-1 queree-policy-0; do
    printf "export const decisionPolicyRevision = '%s';\n" "$revision" \
        >"$work/src/js/queree/policy.js"
    git -C "$work" add .
    git -C "$work" commit -qm "reject revision $revision"
    expect_failure 'decisionPolicyRevision must not decrease numerically'
done
for revision in queree-policy--1 \
    queree-policy-02 queree-policy-3extra queree-policy-x policy-3; do
    printf "export const decisionPolicyRevision = '%s';\n" "$revision" \
        >"$work/src/js/queree/policy.js"
    git -C "$work" add .
    git -C "$work" commit -qm "reject revision $revision"
    expect_failure 'Invalid decisionPolicyRevision'
done
for revision in queree-policy-10 queree-policy-2 queree-policy-3; do
    printf "export const decisionPolicyRevision = '%s';\n" "$revision" \
        >"$work/src/js/queree/policy.js"
    git -C "$work" add .
    git -C "$work" commit -qm "accept revision $revision"
    "$work/tools/check-queree-policy-revision.sh"
done
echo "Passed: compatible watched changes, numeric policy revisions, completed baselines and ad snapshot exemptions"

(
    work="$work/merged-history"
    mkdir -p "$work/tools" "$work/src/js/queree" "$work/dist"
    cp tools/check-queree-policy-revision.sh "$work/tools/"
    git -C "$work" init -q
    git -C "$work" config user.name test
    git -C "$work" config user.email test@example.invalid
    commit_at() {
        GIT_AUTHOR_DATE="@$1 +0000" GIT_COMMITTER_DATE="@$1 +0000" \
            git -C "$work" commit --allow-empty -qm "$2"
    }
    candidate() {
        printf '%s\n' "$1" >"$work/dist/version"
        printf "export const decisionPolicyRevision = 'queree-policy-%s';\n" "$2" \
            >"$work/src/js/queree/policy.js"
        git -C "$work" add .
        commit_at "$3" "$1-policy$2"
    }
    candidate 2.2.9 9 1000000000
    git -C "$work" tag queree-v2.2.9
    git -C "$work" branch older-release
    candidate 2.2.50 50 1000000100
    git -C "$work" tag queree-v2.2.50
    git -C "$work" branch newer-release
    git -C "$work" switch -q older-release
    # The old branch has more commits and a later date, but a lower release.
    for timestamp in 1000000201 1000000202 1000000203; do
        commit_at "$timestamp" older-branch-work
    done
    candidate 2.2.40 40 1000000300
    git -C "$work" tag queree-v2.2.40
    git -C "$work" switch -q newer-release
    GIT_AUTHOR_DATE='@1000000400 +0000' GIT_COMMITTER_DATE='@1000000400 +0000' \
        git -C "$work" merge -q --no-ff -s ours older-release -m merge-older-release
    candidate 2.2.41 41 1000000500
    [ "$(git -C "$work" describe --tags --match 'queree-v*' --abbrev=0 HEAD)" = queree-v2.2.40 ]
    expect_failure 'version must increase: 2.2.50 -> 2.2.41'
    candidate 2.2.50 50 1000000600
    expect_failure 'version must increase: 2.2.50 -> 2.2.50'
    candidate 2.2.51 41 1000000700
    expect_failure 'decisionPolicyRevision must not decrease numerically: queree-policy-50 -> queree-policy-41'
    printf 'compatible presentation change\n' >"$work/src/js/queree/controller.js"
    candidate 2.2.51 50 1000000800
    output=$("$work/tools/check-queree-policy-revision.sh")
    printf '%s\n' "$output" | grep -q 'Policy revision unchanged; confirm saved decisions remain compatible: queree-policy-50'
    candidate 2.2.51 51 1000000900
    "$work/tools/check-queree-policy-revision.sh"
)
find "$work/merged-history" -depth -delete
echo "Passed: merged older releases cannot bypass version/policy monotonicity; compatible policy reuse remains allowed"

# Run the release lifecycle in the disposable repo with simulated test/build
# output, not the extension build or its dependency checkouts.
cp tools/make-queree-private-release.sh "$work/tools/"
cp tools/check-queree-source.sh "$work/tools/"
cp tools/check-queree-source-archive.py "$work/tools/"
# Lifecycle tests simulate generated inputs as well as tests/build output.
cat >"$work/tools/check-queree-generated.mjs" <<'EOF'
import { execFileSync } from 'node:child_process';
if (process.env.TEST_RELEASE_CHANGE_COMMIT) {
    execFileSync('git', ['-C', process.env.TEST_RELEASE_ROOT, 'commit', '--allow-empty', '-qm', 'checkout changed during validation']);
}
EOF
export QUEREE_SERVER_TAXONOMY_MANIFEST="$work/bin/server-taxonomy.json"
export QUEREE_SERVER_TAXONOMY_DATABASE="$work/bin/server-taxonomy.sqlite3"
deps="$work/dist/build"
mkdir -p "$deps/uAssets/main/src/technologies" "$work/bin" \
    "$work/src/js/queree/vendor" "$work/test/queree/fixtures"
for path in LICENSE README.md schema.json src/categories.json src/technologies/a.json; do
    printf '{}\n' >"$deps/uAssets/main/$path"
done
git -C "$deps/uAssets/main" init -q
git -C "$deps/uAssets/main" config user.name test
git -C "$deps/uAssets/main" config user.email test@example.invalid
git -C "$deps/uAssets/main" add .
git -C "$deps/uAssets/main" commit -qm dependency-fixture
dependency_commit=$(git -C "$deps/uAssets/main" rev-parse HEAD)
mkdir -p "$deps/queree-release-sources"
cp -R "$deps/uAssets/main" "$deps/uAssets/prod"
cp -R "$deps/uAssets/main" "$deps/queree-release-sources/opentechalyzer"
cp -R "$deps/uAssets/main" "$deps/queree-release-sources/webappanalyzer"
cat >"$work/tools/queree-release-sources.lock" <<EOF
UASSETS_MAIN_COMMIT=$dependency_commit
UASSETS_PROD_COMMIT=$dependency_commit
OPENTECHALYZER_COMMIT=$dependency_commit
WEBAPPANALYZER_COMMIT=$dependency_commit
OPENTECHALYZER_REPOSITORY=$deps/uAssets/main
WEBAPPANALYZER_REPOSITORY=$deps/uAssets/main
EOF
cp tools/pull-queree-release-sources.sh "$work/tools/"
"$work/tools/pull-queree-release-sources.sh"
cache="$deps/queree-release-sources/opentechalyzer"
for kind in tracked untracked ignored; do
    case "$kind" in
        tracked) changed="$cache/LICENSE" ;;
        untracked) changed="$cache/extra-source.js" ;;
        ignored)
            changed="$cache/compiled.js"
            printf 'compiled.js\n' >>"$cache/.git/info/exclude"
            ;;
    esac
    printf 'altered input\n' >"$changed"
    if output=$("$work/tools/pull-queree-release-sources.sh" 2>&1); then
        echo "Accepted $kind changes in pinned source cache" >&2
        exit 1
    fi
    printf '%s\n' "$output" | grep -q 'Modified source cache'
    if output=$(sh "$work/tools/check-queree-source.sh" "$cache" OPENTECHALYZER_COMMIT 2>&1); then
        echo "Generator accepted $kind changes in pinned source cache" >&2; exit 1
    fi
    printf '%s\n' "$output" | grep -q 'Modified source cache'
    if [ "$kind" = tracked ]; then
        cp "$deps/uAssets/main/LICENSE" "$changed"
    else
        rm "$changed"
    fi
done
"$work/tools/pull-queree-release-sources.sh"
git -C "$cache" update-index --assume-unchanged LICENSE
printf 'hidden alteration\n' >"$cache/LICENSE"
if sh "$work/tools/check-queree-source.sh" "$cache" OPENTECHALYZER_COMMIT >/dev/null 2>&1; then
    echo 'Accepted assume-unchanged source alteration' >&2; exit 1
fi
git -C "$cache" update-index --no-assume-unchanged LICENSE
cp "$deps/uAssets/main/LICENSE" "$cache/LICENSE"
echo "Passed: pinned source caches reject altered, untracked and ignored files"
pull="$work/pull-check"
mkdir -p "$pull/tools"
cp tools/pull-queree-release-sources.sh tools/check-queree-source.sh "$pull/tools/"
cp "$work/tools/queree-release-sources.lock" "$pull/tools/"
sed -i "s|^OPENTECHALYZER_REPOSITORY=.*|OPENTECHALYZER_REPOSITORY=$pull/missing|" "$pull/tools/queree-release-sources.lock"
if "$pull/tools/pull-queree-release-sources.sh" >/dev/null 2>&1; then
    echo 'Accepted failed dependency fetch' >&2; exit 1
fi
[ ! -e "$pull/dist/build/queree-release-sources/opentechalyzer" ]
[ -z "$(find "$pull/dist/build/queree-release-sources" -name '.checkout.*' -print)" ]
cp "$work/tools/queree-release-sources.lock" "$pull/tools/"
"$pull/tools/pull-queree-release-sources.sh"
find "$pull" -depth -delete
echo 'Passed: failed dependency fetch is clean and retryable'
archive="$work/archive-container/archive-check"
mkdir -p "$archive/tools" "$archive/third_party_sources/opentechalyzer" "$archive/unpinned"
cp tools/check-queree-source.sh "$archive/tools/"
cp tools/check-queree-source-archive.py "$archive/tools/"
cp "$work/tools/queree-release-sources.lock" "$archive/tools/"
printf 'OpenTechalyzer: %s\n' "$dependency_commit" >"$archive/SOURCE-MANIFEST.txt"
printf 'pinned\n' >"$archive/third_party_sources/opentechalyzer/input.js"
(cd "$archive/.." && zip -qr fixture-source.zip archive-check && sha256sum fixture-source.zip >SHA256SUMS)
sh "$archive/tools/check-queree-source.sh" "$archive/third_party_sources/opentechalyzer" OPENTECHALYZER_COMMIT
printf 'altered\n' >"$archive/third_party_sources/opentechalyzer/input.js"
if sh "$archive/tools/check-queree-source.sh" "$archive/third_party_sources/opentechalyzer" OPENTECHALYZER_COMMIT >/dev/null 2>&1; then
    echo 'Accepted altered extracted source' >&2; exit 1
fi
printf 'pinned\n' >"$archive/third_party_sources/opentechalyzer/input.js"
printf 'altered zip\n' >>"$archive/../fixture-source.zip"
if sh "$archive/tools/check-queree-source.sh" "$archive/third_party_sources/opentechalyzer" OPENTECHALYZER_COMMIT >/dev/null 2>&1; then
    echo 'Accepted wrong source ZIP checksum' >&2; exit 1
fi
if sh "$archive/tools/check-queree-source.sh" "$archive/unpinned" OPENTECHALYZER_COMMIT >/dev/null 2>&1; then
    echo 'Accepted arbitrary non-Git sources as a release archive' >&2; exit 1
fi
find "$work/archive-container" -depth -delete
echo "Passed: archived pinned sources work without Git; arbitrary directories do not"
printf 'dist/build/\ndist/releases/\nbin/\n' >"$work/.gitignore"
printf '{"type":"module"}\n' >"$work/package.json"
printf 'export default { categories: {} };\n' \
    >"$work/src/js/queree/vendor/domain-index-data.js"
printf 'export const promotionSources = [];\nexport const affiliateLinkSources = [{ name: "test_links", license: "test terms", sha256: "fixture", source: "https://example.invalid/links" }];\n' \
    >"$work/src/js/queree/vendor/website-lists.js"
mkdir -p "$work/src/js/queree/vendor/ublacklist"
printf '// matcher fixture\n' >"$work/src/js/queree/vendor/ublacklist/match-pattern.js"
for path in LICENSE.txt THIRD_PARTY_NOTICES.txt QUEREE_BUILDING.md \
    QUEREE_PRIVACY.md assets/queree/easylist-spanish.txt; do
    printf 'fixture\n' >"$work/$path"
done
cat >"$work/bin/npm" <<'EOF'
#!/bin/sh
[ -z "${TEST_RELEASE_LOG:-}" ] || printf 'tests ran\n' >>"$TEST_RELEASE_LOG"
if [ "${TEST_RELEASE_CONCURRENT:-0}" = 1 ]; then
    if output=$(TEST_RELEASE_CONCURRENT=0 bash "$TEST_RELEASE_ROOT/tools/make-queree-private-release.sh" 2>&1); then
        echo 'Concurrent release was accepted' >&2; exit 1
    fi
    printf '%s\n' "$output" | grep -q 'Another private release is running' || exit 1
fi
exit "${TEST_RELEASE_FAILURE:-0}"
EOF
chmod +x "$work/bin/npm"
cat >"$work/tools/make-firefox.sh" <<'EOF'
#!/bin/sh
python3 - <<'PY'
import json
from pathlib import Path
from zipfile import ZipFile

build = Path('dist/build')
build.mkdir(parents=True, exist_ok=True)
(build / 'uBlock0.firefox').mkdir()
with ZipFile(build / 'uBlock0.firefox.xpi', 'w') as archive:
    archive.writestr('manifest.json', json.dumps({
        'name': 'uBlock Origin + Quer.ee',
        'version': Path('dist/version').read_text().strip(),
        'browser_specific_settings': {'gecko': {'id': 'queree@mekineer.com'}},
    }))
    for name in ('LICENSE.txt', 'THIRD_PARTY_NOTICES.txt'):
        archive.write(name)
PY
EOF
sed -i 's/queree-policy-3/queree-policy-4/' "$work/src/js/queree/policy.js"
git -C "$work" add .
git -C "$work" commit -qm release-fixture
git -C "$work" branch upstream/master

# A same-version tag on an unrelated commit must fail before tests or building.
orphan=$(printf 'unrelated release\n' | git -C "$work" commit-tree \
    "$(git -C "$work" rev-parse HEAD^{tree})")
git -C "$work" tag queree-v2.2.10 "$orphan"
if output=$(PATH="$work/bin:$PATH" TEST_RELEASE_LOG="$work/bin/tests.log" \
    bash "$work/tools/make-queree-private-release.sh" 2>&1); then
    echo "Release accepted an unreachable same-version tag" >&2
    exit 1
fi
printf '%s\n' "$output" | grep -q 'Release tag already exists'
[ ! -e "$work/bin/tests.log" ]
[ ! -e "$work/dist/releases" ]
git -C "$work" tag -d queree-v2.2.10 >/dev/null

if output=$(PATH="$work/bin:$PATH" TEST_RELEASE_CHANGE_COMMIT=1 TEST_RELEASE_ROOT="$work" \
    bash "$work/tools/make-queree-private-release.sh" 2>&1); then
    echo 'Release accepted a checkout change during validation' >&2; exit 1
fi
printf '%s\n' "$output" | grep -q 'Checkout changed during release validation'
[ ! -e "$work/dist/releases" ]

if output=$(PATH="$work/bin:$PATH" TEST_RELEASE_FAILURE=1 \
    bash "$work/tools/make-queree-private-release.sh" 2>&1); then
    echo "Release ignored failing tests" >&2
    exit 1
fi
[ -z "$(git -C "$work" tag -l queree-v2.2.10)" ]
[ -z "$(find "$work/dist/releases" -mindepth 1 -print)" ]

# Inject failures at late lifecycle steps; no final or staging debris may remain.
for command in zip sha256sum mv git; do
    real_command=$(command -v "$command")
    cat >"$work/bin/$command" <<'EOF'
#!/bin/sh
set -eu
case "${TEST_RELEASE_FAILURE_STEP-}:$(basename "$0")" in
    zip:zip) printf 'partial archive\n' >"$2"; exit 1 ;;
    checksum:sha256sum) if [ "$#" -gt 1 ]; then printf 'partial sums\n'; exit 1; fi ;;
    publish:mv) exit 1 ;;
    tag:git) if [ "${3-}" = tag ]; then exit 1; fi ;;
esac
if [ "$(basename "$0")" = mv ]; then
    [ -f "$1/SHA256SUMS" ] && [ ! -e "$2" ]
fi
EOF
    if [ "$command" = mv ]; then
        printf '"%s" "$@"\n' "$real_command" >>"$work/bin/$command"
        printf '[ "${TEST_RELEASE_FAILURE_STEP-}" != signal ] || kill -TERM "$PPID"\n' >>"$work/bin/$command"
    else
        printf 'exec "%s" "$@"\n' "$real_command" >>"$work/bin/$command"
    fi
    chmod +x "$work/bin/$command"
done
for failure in zip checksum publish tag signal; do
    if output=$(PATH="$work/bin:$PATH" TEST_RELEASE_FAILURE_STEP="$failure" \
        bash "$work/tools/make-queree-private-release.sh" 2>&1); then
        echo "Release ignored failing $failure" >&2
        exit 1
    fi
    [ -z "$(git -C "$work" tag -l queree-v2.2.10)" ]
    [ -z "$(find "$work/dist/releases" -mindepth 1 -print)" ]
done
# Simulate SIGKILL after publication but before completion tagging.
orphan_release="$work/dist/releases/quer-ee-$(cat "$work/dist/version")-$(git -C "$work" rev-parse --short=9 HEAD)"
mkdir -p "$orphan_release"
printf 'interrupted\n' >"$orphan_release/partial"
chmod -R a-w "$orphan_release"
PATH="$work/bin:$PATH" TEST_RELEASE_CONCURRENT=1 TEST_RELEASE_ROOT="$work" \
    bash "$work/tools/make-queree-private-release.sh"
[ ! -e "$orphan_release/partial" ]
[ "$(git -C "$work" rev-parse queree-v2.2.10)" = \
    "$(git -C "$work" rev-parse HEAD)" ]
release=$(find "$work/dist/releases" -name SHA256SUMS)
grep -Fq 'Link data: test_links | test terms | sha256:fixture | https://example.invalid/links' \
    "$(dirname "$release")/SOURCE-MANIFEST.txt"
(cd "$(dirname "$release")" && sha256sum -c SHA256SUMS)
python3 - "$(dirname "$release")" <<'PY'
import sys
from pathlib import Path

release = Path(sys.argv[1])
assert all(path.stat().st_mode & 0o222 == 0 for path in [release, *release.iterdir()])
PY
if output=$(PATH="$work/bin:$PATH" \
    bash "$work/tools/make-queree-private-release.sh" 2>&1); then
    echo "Release overwrote a completed release" >&2
    exit 1
fi
printf '%s\n' "$output" | grep -q 'Release tag already exists'
(cd "$(dirname "$release")" && sha256sum -c SHA256SUMS)
printf '2.2.11\n' >"$work/dist/version"
printf 'later verdict logic\n' >>"$work/src/js/queree/controller.js"
git -C "$work" add .
git -C "$work" commit -qm after-release
"$work/tools/check-queree-policy-revision.sh"
sed -i 's/queree-policy-4/queree-policy-3/' "$work/src/js/queree/policy.js"
git -C "$work" add .
git -C "$work" commit -qm decreased-policy-after-release
expect_failure 'decisionPolicyRevision must not decrease numerically'
echo "Passed: atomic, retryable release publication, tag preflight and completed-release baselines"

# Tiny ZIPs exercise archive structure, not cryptographic signature validation.
python3 - tools/verify-queree-signed-xpi.py "$work" <<'PY'
import subprocess
import sys
import warnings
from pathlib import Path
from zipfile import ZipFile

verifier = sys.argv[1]
root = Path(sys.argv[2])
payload = [('manifest.json', b'{}'), ('payload.js', b'release bytes')]
jar = [(f'META-INF/{name}', b'signature fixture')
       for name in ('manifest.mf', 'mozilla.rsa', 'mozilla.sf')]
cose = [(f'META-INF/{name}', b'signature fixture')
        for name in ('cose.manifest', 'cose.sig')]


def check(label, unsigned, signed, error=None):
    paths = [root / 'unsigned.xpi', root / 'signed.xpi']
    for path, entries in zip(paths, (unsigned, signed)):
        with ZipFile(path, 'w') as archive, warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)  # Deliberate duplicates.
            for name, data in entries:
                archive.writestr(name, data)
    result = subprocess.run([sys.executable, verifier, *map(str, paths)],
                            capture_output=True, text=True)
    if error is None:
        assert result.returncode == 0, (label, result.stderr)
    else:
        assert result.returncode != 0 and error in result.stderr, (label, result)


for signatures in (jar, cose, jar + cose):
    check('complete signature shape', payload, payload + signatures)
    if signatures == jar + cose:
        continue
    for index in range(len(signatures)):
        check('missing signature file', payload,
              payload + signatures[:index] + signatures[index + 1:],
              'signature file set')
        empty = signatures.copy()
        empty[index] = (empty[index][0], b'')
        check('empty signature file', payload, payload + empty, 'signature file set')
    check('signature directories', payload,
          payload + [(name + '/', data) for name, data in signatures],
          'signature file set')

for metadata in ([], [('META-INF/', b'')], [('META-INF/x', b'dummy')]):
    check('not a signature', payload, payload + metadata, 'signature file set')
check('changed payload', payload, [payload[0], ('payload.js', b'changed')] + jar,
      'changed payload file')
check('missing payload', payload, payload[:1] + jar, 'payload file list differs')
check('added payload', payload, payload + [('extra.js', b'extra')] + jar,
      'payload file list differs')
for earlier_bytes in (b'different earlier bytes', b'release bytes'):
    duplicate = [('payload.js', earlier_bytes)] + payload
    check('duplicate unsigned payload', duplicate, payload + jar,
          'unsigned XPI contains duplicate ZIP names')
    check('duplicate signed payload', payload, duplicate + jar,
          'signed XPI contains duplicate ZIP names')
check('duplicate unsigned metadata', payload + jar + jar[:1], payload + jar,
      'unsigned XPI contains duplicate ZIP names')
check('duplicate signed metadata', payload, payload + jar + jar[:1],
      'signed XPI contains duplicate ZIP names')
print('Passed: signed-XPI payload equality, duplicate rejection and JAR/COSE signature shapes')
PY

meta="$work/firefox-meta"
mkdir -p "$meta/tools" "$meta/dist" "$meta/build/_locales"
cp tools/make-firefox-meta.py "$meta/tools/"
printf '1.2.3\n' >"$meta/dist/version"
printf '{"sidebar_action": {}, "name": "uBlock Origin + Quer.ee"}\n' \
    >"$meta/build/manifest.json"
cp -R src/_locales/. "$meta/build/_locales/"
cp -R "$meta/build/_locales/nb" "$meta/build/_locales/no"
cp -R "$meta/build/_locales" "$meta/original-locales"
python3 "$meta/tools/make-firefox-meta.py" "$meta/build"
python3 - "$meta" <<'PY'
import json
import re
import sys
from pathlib import Path

meta = Path(sys.argv[1])
identity_keys = {
    'extName', 'extShortDesc', 'dashboardName',
    'aboutPrivacyPolicy', 'aboutChangelog', 'aboutCode',
    'supportS1H', 'supportS1P1', 'supportS2H', 'supportS2P1',
    'supportS3H', 'supportS3P1', 'supportS4H', 'supportS4P1', 'supportS6H',
}
english = json.loads((meta / 'original-locales/en/messages.json').read_text())
for original in (meta / 'original-locales').glob('*/messages.json'):
    expected = json.loads(original.read_text())
    for key, entry in expected.items():
        source = english.get(key, {}).get('message', '')
        if key in identity_keys:
            entry['message'] = source
        elif 'my-ubo-q-' in source:
            entry['message'] = re.sub(r'ublock(?: origin|₀)?', 'ubo-q', entry['message'], flags=re.IGNORECASE)
        elif 'uBO+Q' in source:
            entry['message'] = re.sub(r'uBlock(?: Origin|₀)?|uBO(?!\+Q)', 'uBO+Q', entry['message'])
    output = meta / 'build/_locales' / original.parent.name / 'messages.json'
    assert json.loads(output.read_text()) == expected, original.parent.name
    assert expected['supportS2P1']['message'] == english['supportS2P1']['message']
    assert 'not affiliated with or endorsed by' in expected['supportS2P1']['message']
    for key in ('statsPageName', 'assetViewerPageName', 'popupPowerSwitchInfo', 'docblockedPrompt1'):
        if key in expected:
            assert 'uBlock' not in expected[key]['message'], (original.parent.name, key)

manifest = json.loads((meta / 'build/manifest.json').read_text())
assert manifest == {'name': 'uBlock Origin + Quer.ee', 'version': '1.2.3'}
PY
echo "Passed: Firefox identity and support routing cover all locales without replacing unrelated translations"

# Execute only the taxonomy sorter and digest with tiny rows, not vendored data.
node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const expected = [
    [ 'adult_domain', 'aa.dk' ],
    [ 'adult_domain', 'bc.dk' ],
    [ 'public_interest_organization', 'a-b.dk' ],
    [ 'public_interest_organization', 'a.dk' ],
    [ 'public_interest_organization', 'aa.dk' ],
    [ 'public_interest_organization', 'bc.dk' ],
];
const script = `
    import { buildTaxonomy } from './tools/queree-taxonomy.mjs';
    const result = buildTaxonomy({
        adult_domain: [ { name: 'adult', domains: [ 'bc.dk', 'aa.dk' ] } ],
        public_interest_organization: [ { name: 'public', domains: [ 'bc.dk', 'aa.dk', 'a.dk', 'a-b.dk' ] } ],
    }, { nonExclusiveHosts: [], nonExclusiveHostSuffixes: [], ownershipCategories: new Set() });
    console.log(JSON.stringify({ ...result,
        control: [ 'bc.dk', 'aa.dk' ].sort((a, b) => a.localeCompare(b)),
    }));
`;
const results = [ 'en_US.UTF-8', 'da_DK.UTF-8' ].map(locale => JSON.parse(
    execFileSync(process.execPath, [ '--input-type=module', '-e', script ], {
        encoding: 'utf8', env: { ...process.env, LANG: locale, LC_ALL: locale },
    })
));
assert.notDeepEqual(results[0].control, results[1].control,
    'The fixture must expose the English/Danish locale ordering difference');
for ( const result of results ) {
    assert.deepEqual(result.rows, expected);
}
assert.equal(results[0].revision, results[1].revision,
    'Identical taxonomy rows must produce the same revision across locales');
console.log('Passed: taxonomy row order and revision are locale-independent');
JS

# Run the real packager with stubbed preparation and disposable tiny ZIPs.
package="$work/firefox-package"
mkdir -p "$package/tools" "$package/platform/firefox" \
    "$package/src/assets/queree" "$package/input/js/queree/vendor" \
    "$package/input/_locales/nb" "$package/input/img" \
    "$package/input/assets/queree/adult-lists" \
    "$package/input/assets/queree/website-lists/fake-stores" \
    "$package/input/assets/queree/website-lists/affiliate-publishers" \
    "$package/input/assets/queree/website-lists/affiliate-links"
cp tools/make-firefox.sh "$package/tools/"
printf 'if (process.env.TEST_GENERATED_FAIL) throw new Error("stale generated pair");\n' >"$package/tools/check-queree-generated.mjs"
cat >"$package/tools/copy-common-files.sh" <<'EOF'
#!/bin/sh
set -eu
[ "${TEST_PACKAGE_FAIL_PREP:-0}" = 0 ] || exit 1
cp -R input/. "$1/"
EOF
printf '# Metadata preparation is not under test.\n' >"$package/tools/make-firefox-meta.py"
printf '{}\n' >"$package/platform/firefox/manifest.json"
printf '// platform fixture\n' >"$package/platform/firefox/platform.js"
printf 'tiny index\n' >"$package/src/assets/queree/domain-index.bin"
printf '{}\n' >"$package/input/_locales/nb/messages.json"
printf 'icon\n' >"$package/input/img/icon_128.png"
printf 'runtime\n' >"$package/input/js/queree/runtime.js"
printf 'packaged input\n' >"$package/input/assets/queree/adult-lists/domains.txt"
printf 'store input\n' >"$package/input/assets/queree/website-lists/fake-stores/domains.txt"
printf 'publisher input\n' >"$package/input/assets/queree/website-lists/affiliate-publishers/English.txt"
for name in soteria.txt SOTERIA_README.md dropship-redirects.txt; do
    printf 'attributed link input\n' >"$package/input/assets/queree/website-lists/affiliate-links/$name"
done
printf 'URL input\n' >"$package/input/assets/queree/website-lists/advertorials.txt"
printf '{}\n' >"$package/input/assets/queree/website-lists/provenance.json"
printf 'required terms\n' >"$package/input/assets/queree/website-lists/LICENSE"
for fallback in popupads adguard-ads easylist-spanish; do
    printf 'bundled fallback\n' >"$package/input/assets/queree/$fallback.txt"
done
for source in adult commercial corporate institutional public-interest; do
    printf 'generator input\n' >"$package/input/js/queree/vendor/$source-domains.js"
done
for branch in all 1.2.3; do
    # Seed exactly the stale archive an earlier all build could leave behind.
    python3 - "$package" <<'PY'
import sys
from pathlib import Path
from zipfile import ZipFile

build = Path(sys.argv[1]) / 'dist/build'
build.mkdir(parents=True, exist_ok=True)
with ZipFile(build / 'uBlock0.firefox.xpi', 'w') as archive:
    archive.writestr('removed-file.txt', 'obsolete')
    for source in ('adult', 'commercial', 'corporate', 'reviewed', 'institutional', 'public-interest'):
        archive.writestr(f'js/queree/vendor/{source}-domains.js', 'obsolete')
PY
    (cd "$package" && bash tools/make-firefox.sh "$branch")
    if [ "$branch" = all ]; then
        xpi="$package/dist/build/uBlock0.firefox.xpi"
    else
        xpi="$package/dist/build/uBlock0_$branch.firefox.xpi"
        [ ! -e "$package/dist/build/uBlock0.firefox.xpi" ]
    fi
    python3 - "$xpi" <<'PY'
import sys
from zipfile import ZipFile

with ZipFile(sys.argv[1]) as archive:
    names = set(archive.namelist())
    assert 'removed-file.txt' not in names, sys.argv[1]
    for source in ('adult', 'commercial', 'corporate', 'reviewed', 'institutional', 'public-interest'):
        assert f'js/queree/vendor/{source}-domains.js' not in names, sys.argv[1]
    assert archive.read('js/queree/runtime.js') == b'runtime\n'
    assert archive.read('assets/queree/domain-index.bin') == b'tiny index\n'
    assert not any(name.startswith('assets/queree/adult-lists/') for name in names)
    assert {name for name in names if name.startswith('assets/queree/website-lists/') and not name.endswith('/')} == {
        'assets/queree/website-lists/LICENSE',
        'assets/queree/website-lists/affiliate-links/soteria.txt',
        'assets/queree/website-lists/affiliate-links/SOTERIA_README.md',
        'assets/queree/website-lists/affiliate-links/dropship-redirects.txt',
    }
    assert archive.read('assets/queree/website-lists/LICENSE') == b'required terms\n'
    assert archive.read('assets/queree/website-lists/affiliate-links/SOTERIA_README.md') == b'attributed link input\n'
    for fallback in ('popupads', 'adguard-ads', 'easylist-spanish'):
        assert archive.read(f'assets/queree/{fallback}.txt') == b'bundled fallback\n'
    assert archive.read('manifest.json') == b'{}\n'
    assert '_locales/no/messages.json' in names
PY
done
echo "Passed: both Firefox packaging branches discard stale ZIP entries and retain current inputs"

mkdir -p "$package/bin"
printf '#!/bin/sh\nprintf "partial ZIP\\n" >"$1"\nexit 1\n' >"$package/bin/zip"
chmod +x "$package/bin/zip"
for branch in all 1.2.3; do
    for failure in preparation zip generated; do
        (cd "$package" && bash tools/make-firefox.sh "$branch") >/dev/null
        if [ "$failure" = preparation ]; then
            if (cd "$package" && TEST_PACKAGE_FAIL_PREP=1 bash tools/make-firefox.sh "$branch") >/dev/null 2>&1; then
                echo 'Packager ignored preparation failure' >&2; exit 1
            fi
        elif [ "$failure" = generated ]; then
            if (cd "$package" && TEST_GENERATED_FAIL=1 bash tools/make-firefox.sh "$branch") >/dev/null 2>&1; then
                echo 'Packager ignored generated-pair failure' >&2; exit 1
            fi
        else
            if (cd "$package" && PATH="$package/bin:$PATH" bash tools/make-firefox.sh "$branch") >/dev/null 2>&1; then
                echo 'Packager ignored ZIP failure' >&2; exit 1
            fi
        fi
        if [ "$branch" = all ]; then target=uBlock0.firefox.xpi; else target="uBlock0_$branch.firefox.xpi"; fi
        [ ! -e "$package/dist/build/$target" ]
        [ ! -e "$package/dist/build/uBlock0.firefox.xpi" ]
        [ -z "$(find "$package/dist/build" -name '.queree-xpi.*' -print)" ]
    done
done
echo "Passed: failed Firefox preparation and ZIP creation leave no stale or partial target"
