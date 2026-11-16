#!/usr/bin/env node

/* globals process */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isProfileAddress, profileAddressSource } from './queree-profile-addresses.mjs';
import { communityDomainFromHostname } from '../src/js/queree/community-domains.js';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { isNonExclusiveHost } from '../src/js/queree/nonexclusive-hosts.js';
import { resolve } from 'node:path';
import { snapshotDate } from './queree-snapshot-date.mjs';
import { spawn } from 'node:child_process';
import { websiteHost } from './queree-website-host.mjs';
import { withStagedOutputs } from './queree-generated-files.mjs';

const [ inputArgument, dateArgument, outputArgument ] = process.argv.slice(2);
if ( inputArgument === undefined ) {
    throw new Error(
        'Usage: tools/make-queree-acnc-domains.mjs acnc.csv YYYY-MM-DD [output.js]'
    );
}
const retrievedAt = snapshotDate(dateArgument);

const inputPath = resolve(inputArgument);
const outputPath = resolve(
    outputArgument || 'src/js/queree/vendor/public-interest-domains.js'
);
const pslPath = resolve(
    'dist/build/uAssets/main/thirdparties/publicsuffix.org/list/' +
    'effective_tld_names.dat'
);
const pslText = readFileSync(pslPath, 'utf8');

const extract = spawn('python3', [ '-B',
    fileURLToPath(new URL('./queree-acnc-websites.py', import.meta.url)), inputPath,
], { stdio: [ 'ignore', 'pipe', 'inherit' ] });
const extractExited = new Promise(resolveStatus => extract.on('exit', resolveStatus));
const domains = new Map();
const excluded = { invalid: 0, missing_website: 0, platform: 0, nonexclusive_host: 0, profile_address: 0 };
const lines = createInterface({ input: extract.stdout, crlfDelay: Infinity });
let inputSHA256;

for await ( const line of lines ) {
    const row = JSON.parse(line);
    if ( Array.isArray(row) === false ) { inputSHA256 = row.sha256; continue; }
    const [ abn, website ] = row;
    if ( website.trim() === '' ) {
        excluded.missing_website += 1;
        continue;
    }
    const domain = websiteHost(website, true);
    if ( domain === undefined || /^\d{11}$/.test(abn) === false ) {
        excluded.invalid += 1;
        continue;
    }
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
    let abns = domains.get(domain);
    if ( abns === undefined ) {
        abns = new Set();
        domains.set(domain, abns);
    }
    abns.add(abn);
}
if ( await extractExited !== 0 ) { throw new Error('ACNC CSV extraction failed'); }
if ( domains.size === 0 ) { throw new Error('ACNC extract had no usable domains'); }

const sortedDomains = Array.from(domains.keys()).sort();
const itemsByDomain = Object.fromEntries(sortedDomains.map(domain => [
    domain,
    Array.from(domains.get(domain)).sort(),
]));
await withStagedOutputs([ outputPath ], async ([ path ]) => {
    const existing = existsSync(outputPath)
        ? (await import(pathToFileURL(outputPath).href)).default
            .filter(item => item.name !== 'acnc_australia')
        : [];
    const data = [ ...existing, {
        name: 'acnc_australia',
        source: 'https://data.gov.au/data/dataset/acnc-register',
        license: 'CC-BY-3.0-AU',
        sha256: inputSHA256,
        public_suffix_sha256: createHash('sha256').update(pslText).digest('hex'),
        retrieved_at: retrievedAt,
        rule: 'registered_charity_website',
        profile_address_source: profileAddressSource,
        excluded,
        domains: sortedDomains,
        items_by_domain: itemsByDomain,
    } ];
    writeFileSync(path,
        '/* Generated from official charity-register website fields. */\n\n' +
        `export default ${JSON.stringify(data)};\n`);
});
console.log(`Wrote ${domains.size} ACNC public-interest domains to ${outputPath}`);
