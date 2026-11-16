#!/usr/bin/env node

import { applyReviewedCategory, ownershipHostnameKind, reviewed } from './queree-ownership-sources.mjs';
import { closeSync, createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { domainToASCII, fileURLToPath, pathToFileURL } from 'node:url';
import { isNonExclusiveHost, nonExclusiveHostFromHostname } from '../src/js/queree/nonexclusive-hosts.js';
import { isProfileAddress, profileAddressSource } from './queree-profile-addresses.mjs';
import HNTrieContainer from '../src/js/hntrie.js';
import commercial from '../src/js/queree/vendor/commercial-domains.js';
import { communityDomainFromHostname } from '../src/js/queree/community-domains.js';
import corporate from '../src/js/queree/vendor/corporate-domains.js';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { openSourceSnapshot } from './queree-source-snapshot.mjs';
import process from 'node:process';
import publicSuffixList from '../src/lib/publicsuffixlist/publicsuffixlist.js';
import { resolve } from 'node:path';
import { snapshotDate } from './queree-snapshot-date.mjs';
import { spawn } from 'node:child_process';
import { withStagedOutputs } from './queree-generated-files.mjs';

const [ zipArgument, bmfArgument, yearArgument, dateArgument, outputArgument ] = process.argv.slice(2);
if ( !zipArgument || !bmfArgument || !/^20\d{2}$/.test(yearArgument || '') ) {
    throw new Error('Usage: tools/make-queree-irs-domains.mjs 990n.zip input-directory snapshot-year YYYY-MM-DD [output.js]');
}
const retrievedAt = snapshotDate(dateArgument);
const zipPath = resolve(zipArgument);
const bmfPath = resolve(bmfArgument);
const minimumYear = Number(yearArgument) - 3;
const returnInputs = Array.from({ length: 3 }, (_, offset) =>
    `nccs-header-${minimumYear + offset}.csv`
);
for ( const name of returnInputs ) {
    if ( existsSync(resolve(bmfPath, name)) === false ) {
        throw new Error(`Missing required return table: ${name}; output unchanged`);
    }
}
const outputPath = resolve(outputArgument || 'src/js/queree/vendor/public-interest-domains.js');
const pslText = readFileSync(
    'dist/build/uAssets/main/thirdparties/publicsuffix.org/list/effective_tld_names.dat',
    'utf8'
);
publicSuffixList.parse(pslText, domainToASCII);

async function sha256(fd) {
    const hash = createHash('sha256');
    for await ( const chunk of createReadStream(null, { fd, start: 0, autoClose: false }) ) { hash.update(chunk); }
    closeSync(fd);
    return hash.digest('hex');
}

function hostname(raw) {
    const value = raw.trim();
    let url;
    try {
        url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
    } catch { return; }
    if ( ![ 'http:', 'https:' ].includes(url.protocol) || url.username || url.password ) { return; }
    const host = domainToASCII(url.hostname.toLowerCase().replace(/\.$/, ''))
        .replace(/^www\./, '');
    if ( ownershipHostnameKind(host) === undefined ) { return; }
    const suffix = publicSuffixList.getPublicSuffix(host);
    // Wildcard expansions and exception parents are not literal PSL rules.
    if ( publicSuffixList.suffixInPSL(suffix) === false &&
        publicSuffixList.suffixInPSL(`*.${suffix}`) === false &&
        publicSuffixList.suffixInPSL(`*.${suffix.slice(suffix.indexOf('.') + 1)}`) === false ) { return; }
    return host;
}

// Offline generation uses uBO's existing trie, not a second runtime matcher.
const knownCommercial = new HNTrieContainer();
const inheritedCommercial = new Map();
const exactCommercial = new Set();
// Shopping-domain lists describe page signals, not publisher ownership.
for ( const domain of [ ...commercial.filter(source => source.name === 'ut1_bank'), ...corporate,
    ...reviewed.filter(source => source.category === 'commercial_corporate') ]
    .map(source => applyReviewedCategory(source, 'commercial_corporate'))
    .flatMap(source => source.domains) ) {
    const kind = ownershipHostnameKind(domain);
    if ( kind === undefined ) { continue; }
    if ( kind === 'exact' ) {
        exactCommercial.add(domain);
    } else {
        const boundary = nonExclusiveHostFromHostname(domain);
        if ( inheritedCommercial.has(boundary) === false ) { inheritedCommercial.set(boundary, []); }
        inheritedCommercial.get(boundary).push(domain);
    }
}
const commercialRoots = new Map(Array.from(inheritedCommercial, ([ boundary, domains ]) =>
    [ boundary, knownCommercial.createTrieFromIterable(domains) ]));
const domains = new Map();
const excluded = { invalid: 0, platform: 0, nonexclusive_host: 0, known_commercial: 0, profile_address: 0 };
const zipFD = openSourceSnapshot(zipPath);
const extract = spawn('python3', [ '-B',
    fileURLToPath(new URL('./queree-irs-websites.py', import.meta.url)),
    '/proc/self/fd/3', bmfPath, String(minimumYear),
    ...returnInputs.map(name => resolve(bmfPath, name)),
], { stdio: [ 'ignore', 'pipe', 'inherit', zipFD ] });
const extractExited = new Promise((resolveStatus, reject) => {
    extract.once('error', reject);
    extract.once('close', resolveStatus);
});
const lines = createInterface({ input: extract.stdout, crlfDelay: Infinity });
let counts;
for await ( const line of lines ) {
    const row = JSON.parse(line);
    if ( Array.isArray(row) === false ) { counts = row; continue; }
    const [ ein, website ] = row;
    const domain = hostname(website);
    if ( domain === undefined ) { excluded.invalid += 1; continue; }
    if ( communityDomainFromHostname(domain) !== undefined ) {
        excluded.platform += 1;
        continue;
    }
    if ( isNonExclusiveHost(domain) ) {
        excluded.nonexclusive_host += 1;
        continue;
    }
    if ( isProfileAddress(website) ) {
        excluded.profile_address += 1;
        continue;
    }
    knownCommercial.setNeedle(domain);
    const commercialRoot = commercialRoots.get(nonExclusiveHostFromHostname(domain));
    if ( exactCommercial.has(domain) ||
        (commercialRoot !== undefined && knownCommercial.matches(commercialRoot) !== -1) ) {
        excluded.known_commercial += 1;
        continue;
    }
    if ( domains.has(domain) === false ) { domains.set(domain, new Set()); }
    domains.get(domain).add(ein);
}
if ( await extractExited !== 0 || counts === undefined || domains.size === 0 ) {
    throw new Error('IRS extraction failed or contained no usable domains; output unchanged');
}
const inputSHA256 = counts.input_sha256;
delete counts.input_sha256;
const websiteErrata = counts.website_errata;
delete counts.website_errata;

const statusSources = [];
for ( let region = 1; region <= 4; region++ ) {
    const headers = resolve(bmfPath, `eo${region}.headers`);
    statusSources.push({
        source: `https://www.irs.gov/pub/irs-soi/eo${region}.csv`,
        sha256: inputSHA256[`eo${region}.csv`],
        last_modified: existsSync(headers)
            ? readFileSync(headers, 'utf8').match(/^last-modified:\s*(.+)$/im)?.[1].trim()
            : undefined,
    });
}
const sortedDomains = Array.from(domains.keys()).sort();
const returnSources = [];
for ( const name of returnInputs ) {
    const year = /^nccs-header-(20\d{2})\.csv$/.exec(name)[1];
    const headers = resolve(bmfPath, name.replace(/\.csv$/, '.headers'));
    returnSources.push({
        source: `https://nccs-efile.s3.us-east-1.amazonaws.com/public/efile_v3_1/F9-P00-T00-HEADER-${year}.CSV`,
        sha256: inputSHA256[name],
        last_modified: existsSync(headers)
            ? readFileSync(headers, 'utf8').match(/^last-modified:\s*(.+)$/im)?.[1].trim()
            : undefined,
    });
}
await withStagedOutputs([ outputPath ], async ([ path ]) => {
    const existing = existsSync(outputPath)
        ? (await import(pathToFileURL(outputPath).href)).default
        : [];
    const data = [ ...existing.filter(source =>
        source.name !== 'irs_charities'
    ), {
        name: 'irs_charities',
        source: 'https://apps.irs.gov/pub/epostcard/data-download-epostcard.zip',
        license: 'ODC-By-1.0 (NCCS extract); public domain (IRS source data)',
        attribution: 'NCCS IRS 990 Efile Data, Jesse Lecy, Urban Institute, 2026, v3.1',
        license_url: 'https://opendatacommons.org/licenses/by/1-0/',
        sha256: await sha256(zipFD),
        content_sha256: inputSHA256['data-download-epostcard.txt'],
        status_sources: statusSources,
        return_sources: returnSources,
        public_suffix_sha256: createHash('sha256').update(pslText).digest('hex'),
        retrieved_at: retrievedAt,
        snapshot_year: Number(yearArgument),
        minimum_tax_year: minimumYear,
        profile_address_source: profileAddressSource,
        website_errata: websiteErrata,
        rule: 'latest 990-N/990/990-EZ by period and filing time; nonterminated; current BMF subsection=03/status=01; dated EIN/declaration-specific website errata; exclusive noncommercial website host',
        counts,
        excluded,
        domains: sortedDomains,
        items_by_domain: Object.fromEntries(sortedDomains.map(domain => [
            domain, Array.from(domains.get(domain)).sort(),
        ])),
    } ];
    writeFileSync(path,
        '/* Generated from official charity-register website fields. */\n\n' +
        `export default ${JSON.stringify(data)};\n`);
});
console.log(`Wrote ${domains.size} IRS public-interest domains to ${outputPath}: ${JSON.stringify(excluded)}; ${websiteErrata.applied.length} website errata applied`);
