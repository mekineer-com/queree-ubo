#!/usr/bin/env node

import { domainToASCII, pathToFileURL } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { communityDomainFromHostname } from '../src/js/queree/community-domains.js';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isNonExclusiveHost } from '../src/js/queree/nonexclusive-hosts.js';
import { ownershipHostnameKind } from './queree-ownership-sources.mjs';
import process from 'node:process';
import publicSuffixList from '../src/lib/publicsuffixlist/publicsuffixlist.js';
import { resolve } from 'node:path';
import { snapshotDate as validateSnapshotDate } from './queree-snapshot-date.mjs';
import { withStagedOutputs } from './queree-generated-files.mjs';

const [ inputArgument, snapshotDate, outputArgument ] = process.argv.slice(2);
if ( !inputArgument ) {
    throw new Error('Usage: node tools/make-queree-doaj-domains.mjs CSV SNAPSHOT_DATE [OUTPUT]');
}
validateSnapshotDate(snapshotDate);
const inputPath = resolve(inputArgument);
const input = readFileSync(inputPath);
const outputPath = resolve(outputArgument || 'src/js/queree/vendor/institutional-domains.js');
const rows = JSON.parse(execFileSync('python3', [ '-c', [
    'import csv,io,json,sys',
    'with io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8-sig", newline="") as source:',
    ' reader = csv.DictReader(source, strict=True)',
    ' fields = ("Journal URL", "URL in DOAJ")',
    ' if any((reader.fieldnames or []).count(field) != 1 for field in fields):',
    '  raise ValueError("DOAJ CSV must contain Journal URL and URL in DOAJ columns")',
    ' rows = []',
    ' for row in reader:',
    '  if None in row or None in row.values(): raise ValueError("Malformed DOAJ CSV record")',
    '  rows.append([row[field] for field in fields])',
    ' print(json.dumps(rows))',
].join('\n') ], { input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));

const domains = new Map();
const excluded = { invalid: 0, non_root_url: 0, platform: 0, shared_host: 0 };
for ( const [ raw, recordURL ] of rows ) {
    let url;
    try { url = new URL(raw); } catch { excluded.invalid += 1; continue; }
    const hostname = domainToASCII(url.hostname.replace(/\.$/, '')).replace(/^www\./, '');
    if ( ![ 'http:', 'https:' ].includes(url.protocol) || url.username || url.password ||
        url.port || !recordURL || hostname.length > 253 ||
        hostname.split('.').some(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) === false) ||
        ownershipHostnameKind(hostname) === undefined ) {
        excluded.invalid += 1;
        continue;
    }
    // A journal path does not establish what the rest of its host publishes.
    if ( url.pathname !== '/' || url.search || url.hash ) {
        excluded.non_root_url += 1;
        continue;
    }
    if ( communityDomainFromHostname(hostname) !== undefined ) {
        excluded.platform += 1;
        continue;
    }
    if ( isNonExclusiveHost(hostname) || publicSuffixList.getDomain(hostname) === '' ) {
        excluded.shared_host += 1;
        continue;
    }
    if ( domains.has(hostname) === false ) { domains.set(hostname, new Set()); }
    domains.get(hostname).add(recordURL);
}
if ( domains.size === 0 ) { throw new Error('DOAJ CSV contained no usable journal hosts; output unchanged'); }

const sortedDomains = Array.from(domains.keys()).sort();
await withStagedOutputs([ outputPath ], async ([ path ]) => {
    const existing = existsSync(outputPath) ? (await import(pathToFileURL(outputPath).href)).default : [];
    const pslText = readFileSync(new URL(
        '../dist/build/uAssets/main/thirdparties/publicsuffix.org/list/effective_tld_names.dat', import.meta.url
    ));
    const data = [ ...existing.filter(source => source.name !== 'doaj_journals'), {
        name: 'doaj_journals',
        source: 'https://doaj.org/csv',
        license: 'CC0-1.0',
        license_url: 'https://doaj.org/terms/',
        attribution: 'Directory of Open Access Journals (DOAJ)',
        sha256: createHash('sha256').update(input).digest('hex'),
        public_suffix_sha256: createHash('sha256').update(pslText).digest('hex'),
        snapshot_date: snapshotDate,
        rule: 'journal_root_url; exclude shared hosts and social platforms; retain tenant subdomains',
        record_count: rows.length,
        excluded,
        domains: sortedDomains,
        items_by_domain: Object.fromEntries(sortedDomains.map(domain => [
            domain, Array.from(domains.get(domain)).sort(),
        ])),
    } ];
    writeFileSync(path,
        '/* Generated from attributed professional-publication sources. */\n\n' +
        `export default ${JSON.stringify(data)};\n`);
});
console.log(`Wrote ${domains.size} DOAJ journal hosts: ${JSON.stringify(excluded)}`);
