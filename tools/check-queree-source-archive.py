"""Compare extracted dependencies with the checksummed corresponding-source ZIP."""

import hashlib
from pathlib import Path
import sys
import zipfile

root, directory = map(Path, sys.argv[1:])
prefix = f"{root.name}/{directory.relative_to(root).as_posix()}/"
checksums = (root.parent / "SHA256SUMS").read_text().splitlines()
matches = []
for line in checksums:
    digest, name = line.split(maxsplit=1)
    name = name.lstrip(" *")
    if not name.endswith("-source.zip") or Path(name).name != name:
        continue
    with (root.parent / name).open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != digest:
            raise ValueError("Corresponding-source ZIP checksum mismatch")
        source.seek(0)
        with zipfile.ZipFile(source) as archive:
            names = [name for name in archive.namelist()
                     if name.startswith(prefix) and not name.endswith("/")]
            if not names:
                continue
            expected = {name[len(prefix):] for name in names}
            actual = {path.relative_to(directory).as_posix()
                      for path in directory.rglob("*") if path.is_file()}
            if len(names) != len(expected) or actual != expected:
                raise ValueError("Extracted source archive file set differs")
            for name in names:
                with archive.open(name) as packed, (directory / name[len(prefix):]).open("rb") as extracted:
                    if hashlib.file_digest(packed, "sha256").digest() != hashlib.file_digest(extracted, "sha256").digest():
                        raise ValueError(f"Modified source archive: {name}")
            matches.append(name)
if len(matches) != 1:
    raise ValueError("Supply the published source ZIP and SHA256SUMS beside the extracted source")
