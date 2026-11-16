#!/usr/bin/env python3

import sys
import zipfile


if len(sys.argv) != 3:
    raise SystemExit("usage: verify-queree-signed-xpi.py UNSIGNED_XPI SIGNED_XPI")

with zipfile.ZipFile(sys.argv[1]) as unsigned, zipfile.ZipFile(sys.argv[2]) as signed:
    for label, archive in (("unsigned", unsigned), ("signed", signed)):
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise SystemExit(f"{label} XPI contains duplicate ZIP names")
    unsigned_names = {
        name for name in unsigned.namelist() if not name.upper().startswith("META-INF/")
    }
    signed_names = {
        name for name in signed.namelist() if not name.upper().startswith("META-INF/")
    }
    if unsigned_names != signed_names:
        raise SystemExit("signed XPI payload file list differs")
    for name in sorted(unsigned_names):
        if unsigned.read(name) != signed.read(name):
            raise SystemExit(f"signed XPI changed payload file: {name}")
    # Firefox, not this payload comparison, verifies the cryptographic signature.
    signature_sets = (
        ("META-INF/manifest.mf", "META-INF/mozilla.rsa", "META-INF/mozilla.sf"),
        ("META-INF/cose.manifest", "META-INF/cose.sig"),
    )
    signature_names = set(signed.namelist())
    if not any(
        all(name in signature_names and signed.read(name) for name in group)
        for group in signature_sets
    ):
        raise SystemExit("signed XPI lacks a complete, nonempty JAR or COSE signature file set")

print("Signed XPI payload matches the unsigned release build; signature files present")
