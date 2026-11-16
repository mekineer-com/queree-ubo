#!/usr/bin/env bash
#
# This script assumes a linux environment

set -e

echo "*** uBlock0.firefox: Creating web store package"

BLDIR=dist/build
DES="$BLDIR"/uBlock0.firefox
package="${1-}"
if [ "$package" = all ]; then
    xpi="$BLDIR/uBlock0.firefox.xpi"
elif [ -n "$package" ]; then
    xpi="$BLDIR/uBlock0_$package.firefox.xpi"
fi
if [ -n "$package" ]; then
    # An unsuccessful attempt must not leave a previous build at its target.
    rm -f "$xpi" "$BLDIR/uBlock0.firefox.xpi"
    mkdir -p "$BLDIR"
    archive=$(mktemp "$(pwd)/$BLDIR/.queree-xpi.XXXXXX.zip")
    rm "$archive"
    trap 'rm -f "$archive"' EXIT
    trap 'exit 1' HUP INT TERM
fi
mkdir -p $DES
rm -rf $DES/*

node tools/check-queree-generated.mjs

echo "*** uBlock0.firefox: Copying common files"
bash ./tools/copy-common-files.sh $DES
rm "$DES"/js/queree/vendor/{adult,commercial,corporate,institutional,public-interest}-domains.js
rm -r "$DES/assets/queree/adult-lists" "$DES/assets/queree/website-lists/fake-stores" \
    "$DES/assets/queree/website-lists/affiliate-publishers"
rm "$DES/assets/queree/website-lists/advertorials.txt" \
    "$DES/assets/queree/website-lists/provenance.json"
mkdir -p "$DES"/assets/queree
cp src/assets/queree/domain-index.bin "$DES"/assets/queree/

# Firefox-specific
echo "*** uBlock0.firefox: Copying firefox-specific files"
cp platform/firefox/*.json $DES/
cp platform/firefox/*.js   $DES/js/

# Firefox store-specific
cp -R $DES/_locales/nb     $DES/_locales/no

# Firefox/webext-specific
rm $DES/img/icon_128.png

echo "*** uBlock0.firefox: Generating meta..."
python3 tools/make-firefox-meta.py $DES/

if [ -n "$package" ]; then
    echo "*** uBlock0.firefox: Creating package..."
    pushd $DES > /dev/null
    zip "$archive" -qr *
    popd > /dev/null
    mv "$archive" "$xpi"
fi

echo "*** uBlock0.firefox: Package done."
