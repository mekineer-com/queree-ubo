"""Decode streamed source lines while hashing the exact bytes consumed."""

import hashlib
import io


class HashingReader(io.RawIOBase):
    def __init__(self, raw, digest):
        self.raw = raw
        self.digest = digest

    def readable(self):
        return True

    def readinto(self, buffer):
        length = self.raw.readinto(buffer)
        self.digest.update(memoryview(buffer)[:length])
        return length


def source_lines(raw, hashes, name):
    digest = hashlib.sha256()

    with io.TextIOWrapper(io.BufferedReader(HashingReader(raw, digest)),
                          encoding="utf-8-sig", newline="") as source:
        yield from source
    hashes[name] = digest.hexdigest()
