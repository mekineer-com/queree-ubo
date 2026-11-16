#!/bin/sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
mode=${1-}
set -- \
    assets/assets.json \
    assets/queree/adult-lists \
    assets/queree/website-lists \
    src/js/queree \
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
    src/js/resources \
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
    src/lib/csstree \
    src/lib/publicsuffixlist \
    src/lib/punycode.js \
    src/lib/regexanalyzer \
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

# Also available in source archives, so fixtures can validate this exact list.
if [ "$mode" = --watched-paths ]; then
    printf '%s\n' "$@"
    exit 0
fi

# A merged older release can be nearer in history than the highest version.
previous=$(git -C "$ROOT" tag --merged HEAD --list 'queree-v*' --sort=-version:refname |
    sed -n '1p')
[ -n "$previous" ] || {
    echo "Missing completed release baseline: tag the last built release queree-v<version>" >&2
    exit 1
}

policy_revision() {
    git -C "$ROOT" show "$1:src/js/queree/policy.js" |
        sed -n "s/^export const decisionPolicyRevision = '\([^']*\)';$/\1/p"
}

current_revision=$(policy_revision HEAD)
[ -n "$current_revision" ] || {
    echo "Current decisionPolicyRevision is missing" >&2
    exit 1
}

previous_version=${previous#queree-v}
current_version=$(cat "$ROOT/dist/version")
python3 - "$previous_version" "$current_version" <<'PY'
import re
import sys

pattern = re.compile(r"^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){0,3}$")
old, new = sys.argv[1:]
if not pattern.fullmatch(old) or not pattern.fullmatch(new):
    raise SystemExit(f"Invalid release version: {old!r} -> {new!r}")
old_parts = tuple(map(int, old.split(".")))
new_parts = tuple(map(int, new.split(".")))
width = max(len(old_parts), len(new_parts))
if new_parts + (0,) * (width - len(new_parts)) <= old_parts + (0,) * (width - len(old_parts)):
    raise SystemExit(f"Quer.ee version must increase: {old} -> {new}")
PY

previous_revision=$(policy_revision "$previous")
[ -n "$previous_revision" ] || {
    echo "Previous decisionPolicyRevision is missing at $previous" >&2
    exit 1
}
python3 - "$previous_revision" "$current_revision" <<'PY'
import re
import sys

old, new = sys.argv[1:]
pattern = re.compile(r"queree-policy-(0|[1-9][0-9]*)")
revisions = [pattern.fullmatch(value) for value in (old, new)]
if not all(revisions):
    raise SystemExit(f"Invalid decisionPolicyRevision: {old!r} -> {new!r}")
if int(revisions[1][1]) < int(revisions[0][1]):
    raise SystemExit(f"decisionPolicyRevision must not decrease numerically: {old} -> {new}")
PY

changed=$(git -C "$ROOT" diff --name-only "$previous"..HEAD -- "$@")
[ -n "$changed" ] || {
    echo "No verdict-relevant changes since $previous"
    exit 0
}

# Watched edits can preserve saved decisions; bump only for incompatibility.
if [ "$previous_revision" = "$current_revision" ]; then
    echo "Policy revision unchanged; confirm saved decisions remain compatible: $current_revision"
else
    echo "Policy revision changed: $previous_revision -> $current_revision"
fi
printf '%s\n' "$changed"
