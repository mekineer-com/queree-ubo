"""Stream current IRS charity website declarations; emit no personal fields."""

import csv
from collections import namedtuple
from datetime import date, datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
import zipfile
from queree_source_inputs import source_lines


postcards, directory, minimum_year, *returns = sys.argv[1:]
minimum_year = int(minimum_year)
if not returns:
    raise ValueError('Full-return header tables are required; refusing a 990-N-only replacement')
csv.field_size_limit(16 * 1024 * 1024)
active = set()
hashes = {}
counts = {"bmf_rows": 0, "postcard_rows": 0, "not_current_charity": 0,
          "stale": 0, "terminated": 0, "missing_website": 0,
          "full_return_rows": 0, "ambiguous_ties": 0,
          "blank_latest_with_prior_website": 0}
for region in range(1, 5):
    name = f"eo{region}.csv"
    with (Path(directory) / name).open("rb") as source:
        rows = csv.DictReader(source_lines(source, hashes, name), strict=True)
        if any((rows.fieldnames or []).count(field) != 1
               for field in ("EIN", "SUBSECTION", "STATUS")):
            raise ValueError(f"BMF region {region} lacks required columns")
        for row in rows:
            if None in row or None in row.values():
                raise ValueError('Malformed BMF CSV record')
            counts["bmf_rows"] += 1
            if row["SUBSECTION"] == "03" and row["STATUS"] == "01":
                active.add(row["EIN"])
counts["current_charities"] = len(active)
if not active:
    raise ValueError("No current charities in BMF inputs")

Declaration = namedtuple('Declaration', 'period submitted website final had_website')
latest = {}
errata_path = Path(__file__).with_name('queree-irs-website-errata.json')
errata_bytes = errata_path.read_bytes()
website_errata = json.loads(errata_bytes)
applied_errata = []


def qualifies(ein, year):
    if re.fullmatch(r'[0-9]{9}', ein) is None or re.fullmatch(r'[0-9]{4}', year) is None:
        raise ValueError('Malformed IRS identity/year')
    if ein not in active:
        counts['not_current_charity'] += 1
        return False
    if int(year) < minimum_year:
        counts['stale'] += 1
        return False
    return True


def emit(ein, record):
    if not record.website and record.had_website:
        counts['blank_latest_with_prior_website'] += 1
    if record.final:
        counts['terminated'] += 1
    elif not record.website:
        counts['missing_website'] += 1
    else:
        website = record.website
        # Correct only the selected declaration; never revive a blank/final filing.
        for erratum in website_errata:
            if (ein == erratum['ein']
                    and record.period.isoformat() == erratum['tax_period_end']
                    and record.submitted == datetime.fromisoformat(erratum['submitted_at']).timestamp()
                    and website == erratum['reported_website']):
                website = erratum['corrected_website']
                applied_errata.append(erratum)
        print(json.dumps([ein, website]))


required = {'ORG_EIN', 'TAX_YEAR', 'TAX_PERIOD_END_DATE', 'RETURN_TIME_STAMP',
            'F9_00_ORG_WEBSITE', 'F9_00_RETURN_FINAL_X'}
for path in returns:
    with open(path, "rb") as source:
        rows = csv.DictReader(source_lines(source, hashes, Path(path).name), strict=True)
        if any((rows.fieldnames or []).count(field) != 1 for field in required):
            raise ValueError('Full-return table lacks required columns')
        for row in rows:
            if None in row or None in row.values():
                raise ValueError('Malformed full-return CSV record')
            counts['full_return_rows'] += 1
            ein, year = row['ORG_EIN'], row['TAX_YEAR']
            if not qualifies(ein, year):
                continue
            stamp = datetime.fromisoformat(row['RETURN_TIME_STAMP'])
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=timezone.utc)
            website = row['F9_00_ORG_WEBSITE'].strip()
            record = Declaration(date.fromisoformat(row['TAX_PERIOD_END_DATE']),
                                 stamp.timestamp(), website,
                                 row['F9_00_RETURN_FINAL_X'] == 'X', bool(website))
            previous = latest.get(ein)
            if previous is None:
                latest[ein] = record
                continue
            had_website = record.had_website or previous.had_website
            if record[:2] > previous[:2]:
                latest[ein] = record._replace(had_website=had_website)
            elif record[:2] == previous[:2] and record[2:4] != previous[2:4]:
                # Equally dated contradictory declarations have no known order.
                counts['ambiguous_ties'] += 1
                latest[ein] = previous._replace(website='', had_website=had_website,
                                               final=record.final or previous.final)
            else:
                latest[ein] = previous._replace(had_website=had_website)
counts['full_return_charities'] = len(latest)

# IRS publishes the most recent e-Postcard per EIN. Refuse changed input shape
# rather than silently resurrect an older website or a terminated organization.
seen = set()
with zipfile.ZipFile(postcards) as archive:
    with archive.open("data-download-epostcard.txt") as raw:
        rows = csv.reader(source_lines(raw, hashes, "data-download-epostcard.txt"),
                          delimiter="|", quoting=csv.QUOTE_NONE)
        for row in rows:
            if not row:
                continue
            if (len(row) < 8 or re.fullmatch(r"[0-9]{9}", row[0]) is None
                    or re.fullmatch(r"[0-9]{4}", row[1]) is None):
                raise ValueError("Malformed 990-N record")
            ein, year = row[:2]
            if ein in seen:
                raise ValueError("990-N input contains duplicate EINs")
            seen.add(ein)
            counts["postcard_rows"] += 1
            if not qualifies(ein, year):
                continue
            website = row[7].strip()
            record = Declaration(datetime.strptime(row[6], '%m-%d-%Y').date(),
                                 0, website, row[4] != 'F', bool(website))
            full = latest.pop(ein, None)
            if full is not None:
                chosen = full if full[:2] >= record[:2] else record
                record = chosen._replace(had_website=full.had_website or record.had_website)
                counts['cross_form_charities'] = counts.get('cross_form_charities', 0) + 1
            emit(ein, record)
del seen, active
while latest:
    ein, record = latest.popitem()
    emit(ein, record)
print(json.dumps({**counts, "input_sha256": hashes, "website_errata": {
    "source": f"tools/{errata_path.name}",
    "sha256": hashlib.sha256(errata_bytes).hexdigest(),
    "applied": applied_errata,
}}))
