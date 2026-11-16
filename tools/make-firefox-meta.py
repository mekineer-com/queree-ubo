#!/usr/bin/env python3

import glob
import os
import json
import re
import sys

if len(sys.argv) == 1 or not sys.argv[1]:
    raise SystemExit('Build dir missing.')

proj_dir = os.path.join(os.path.split(os.path.abspath(__file__))[0], '..')
build_dir = os.path.abspath(sys.argv[1])

version = ''
with open(os.path.join(proj_dir, 'dist', 'version')) as f:
    version = f.read().strip()

firefox_manifest = {}
firefox_manifest_file = os.path.join(build_dir, 'manifest.json')
with open(firefox_manifest_file) as f2:
    firefox_manifest = json.load(f2)

if 'sidebar_action' in firefox_manifest:
    match = re.search(r'^(\d+\.\d+\.\d+)(\.\d+)$', version)
    if not match:
        # https://bugzilla.mozilla.org/show_bug.cgi?id=1459007
        # By design Firefox opens the sidebar with new installation of
        # uBO when sidebar_action is present in the manifest.
        # Remove sidebarAction support for stable release of uBO.
        del firefox_manifest['sidebar_action']

firefox_manifest['version'] = version

with open(firefox_manifest_file, 'w') as f2:
    json.dump(firefox_manifest, f2, indent=2, separators=(',', ': '), sort_keys=True)
    f2.write('\n')

# Replace fork-specific copy; otherwise change only the name in translations.
locales_dir = os.path.join(build_dir, '_locales')
identity_keys = {
    'extName', 'extShortDesc', 'dashboardName',
    'aboutPrivacyPolicy', 'aboutChangelog', 'aboutCode',
    'supportS1H', 'supportS1P1', 'supportS2H', 'supportS2P1',
    'supportS3H', 'supportS3P1', 'supportS4H', 'supportS4P1', 'supportS6H',
}
with open(os.path.join(locales_dir, 'en', 'messages.json'), encoding='utf-8') as f:
    english_messages = json.load(f)

for locale_file in glob.glob(os.path.join(locales_dir, '*', 'messages.json')):
    with open(locale_file, encoding='utf-8') as f:
        messages = json.load(f)
    changed = False
    for key, entry in messages.items():
        english = english_messages.get(key, {}).get('message', '')
        message = entry['message']
        if key in identity_keys:
            message = english
        elif 'my-ubo-q-' in english:
            message = re.sub(r'ublock(?: origin|₀)?', 'ubo-q', message, flags=re.IGNORECASE)
        elif 'uBO+Q' in english:
            message = re.sub(r'uBlock(?: Origin|₀)?|uBO(?!\+Q)', 'uBO+Q', message)
        if message != entry['message']:
            entry['message'] = message
            changed = True
    if not changed:
        continue
    with open(locale_file, 'w', encoding='utf-8') as f:
        json.dump(messages, f, ensure_ascii=False, indent=2)
        f.write('\n')
