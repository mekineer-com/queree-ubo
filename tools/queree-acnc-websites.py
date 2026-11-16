import csv
import json
import sys

from queree_source_inputs import source_lines

hashes = {}
with open(sys.argv[1], "rb") as source:
    reader = csv.DictReader(source_lines(source, hashes, "input"), strict=True)
    if any((reader.fieldnames or []).count(field) != 1
           for field in ("ABN", "Charity_Website")):
        raise ValueError("ACNC CSV lacks required columns")
    for row in reader:
        if None in row or None in row.values():
            raise ValueError("Malformed ACNC CSV record")
        print(json.dumps([row["ABN"], row["Charity_Website"]]))
print(json.dumps({"sha256": hashes["input"]}))
