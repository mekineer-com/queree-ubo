#!/usr/bin/env node

import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { isProfileAddress, profileAddressSource } from './queree-profile-addresses.mjs';
import { broadRecordCategories } from './queree-wikidata-broad-categories.mjs';
import { communityDomainFromHostname } from '../src/js/queree/community-domains.js';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { isNonExclusiveHost } from '../src/js/queree/nonexclusive-hosts.js';
import process from 'node:process';
import { resolve } from 'node:path';
import { reviewed } from './queree-ownership-sources.mjs';
import { websiteHost } from './queree-website-host.mjs';
import { withStagedOutputs } from './queree-generated-files.mjs';

const selections = {
    'public-companies': 'commercial_corporate', 'private-direct': 'commercial_corporate',
    'private-types': 'commercial_corporate', 'private-legal': 'commercial_corporate',
    'stock-legal': 'commercial_corporate', 'commercial-direct': 'commercial_corporate',
    'public-universities': 'government_education', 'government-direct': 'government_education',
    'charities-direct': 'public_interest_organization', 'art-museums': 'public_interest_organization',
    'academic-journals': null,
};
const [inputDir, homepageFile, outputArgument] = process.argv.slice(2);
if ( !inputDir || !homepageFile ) {
    throw Error('Usage: node tools/make-queree-wikidata-broad-domains.mjs INPUT_DIR all-homepages.tsv [OUTPUT]');
}
const output = resolve(outputArgument || 'tools/vendor/wikidata-broad-domains.js');
const queryDir = new URL('./vendor/wikidata-broad-queries/', import.meta.url);
const checksums = new Map(readFileSync(new URL('SHA256SUMS', queryDir), 'utf8').trim().split('\n')
    .map(line => line.split(/\s+/).reverse()));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const reviewedHosts = new Set(reviewed.flatMap(source => source.domains));
const hosts = new Map();
const pathHosts = new Set();
const inputHashes = {};
for ( const [name, category] of Object.entries(selections) ) {
    const bytes = readFileSync(resolve(inputDir, `${name}.json`));
    const hash = sha(bytes);
    if ( hash !== checksums.get(`${name}.json`) ) { throw Error(`Input hash mismatch: ${name}.json`); }
    inputHashes[name] = hash;
    const parsed = JSON.parse(bytes);
    if ( !Array.isArray(parsed.results?.bindings) ) { throw Error(`Invalid export: ${name}`); }
    // A journal's website, even at the root, need not identify its portal owner.
    if ( name === 'academic-journals' ) { continue; }
    for ( const row of parsed.results.bindings ) {
        const id = row.item?.value?.match(/\/entity\/(Q\d+)$/)?.[1];
        const url = row.website?.value;
        const host = websiteHost(url || '');
        if ( !id || !host || reviewedHosts.has(host) || host === 'web.archive.org' ||
            communityDomainFromHostname(host) || isNonExclusiveHost(host) || isProfileAddress(url) ) { continue; }
        const address = new URL(url);
        const root = address.pathname === '/' && !address.search && !address.hash;
        if ( !hosts.has(host) ) { hosts.set(host, new Map()); }
        const records = hosts.get(host);
        if ( !records.has(id) ) { records.set(id, { flags: new Set(), government: false, claims: new Map(), companyPath: false }); }
        const record = records.get(id);
        if ( row.nonprofit?.value === 'true' ) { record.flags.add('public_interest_organization'); }
        if ( row.government?.value === 'true' ) { record.government = true; }
        if ( row.government?.value === 'true' || row.education?.value === 'true' ) {
            record.flags.add('government_education');
        }
        record.claims.set(name, category);
        if ( category === 'commercial_corporate' && !root ) {
            record.companyPath = true;
            pathHosts.add(host);
        }
    }
}
// Only root claims for candidate non-root company hosts are needed from the large export.
const roots = new Map();
const digest = createHash('sha256');
const stream = createReadStream(homepageFile);
stream.on('data', chunk => digest.update(chunk));
const lines = createInterface({ input: stream, crlfDelay: Infinity });
for await ( const line of lines ) {
    const match = line.match(/^<http:\/\/www\.wikidata\.org\/entity\/(Q\d+)>\t<([^>]+)>$/);
    if ( !match ) { continue; }
    const host = websiteHost(match[2]);
    if ( !pathHosts.has(host) ) { continue; }
    if ( !roots.has(host) ) { roots.set(host, new Set()); }
    roots.get(host).add(match[1]);
}
if ( digest.digest('hex') !== checksums.get('all-homepages.tsv') ) { throw Error('Homepage input hash mismatch'); }
const outputs = {};
let unresolvedHomepage = 0;
let conflicting = 0;
let companyGovernment = 0;
for ( const [host, records] of hosts ) {
    const rootIds = roots.get(host);
    if ( rootIds && [...records].some(([id, record]) =>
        record.companyPath && [...rootIds].some(root => root !== id)
    ) ) { unresolvedHomepage++; continue; }
    const categories = new Map();
    for ( const [id, record] of records ) {
        const company = [...record.claims.values()].includes('commercial_corporate');
        if ( company && record.government ) {
            companyGovernment++;
        }
        for ( const [name, mapped] of broadRecordCategories(record) ) {
            if ( !categories.has(mapped) ) { categories.set(mapped, new Map()); }
            if ( !categories.get(mapped).has(name) ) { categories.get(mapped).set(name, new Set()); }
            categories.get(mapped).get(name).add(id);
        }
    }
    // Different ownership claims without a distinguishing fact do not select a winner.
    if ( categories.size > 1 ) { conflicting++; continue; }
    for ( const [category, sources] of categories ) for ( const [name, ids] of sources ) {
        outputs[category] ??= {};
        outputs[category][name] ??= {};
        outputs[category][name][host] = [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    }
}
const groups = {};
for ( const [category, sources] of Object.entries(outputs).sort() ) {
    groups[category] = Object.entries(sources).sort().map(([name, domains]) => {
        const sorted = Object.keys(domains).sort();
        return {
            name: `wikidata_broad_${name.replaceAll('-', '_')}_${category}`,
            source: 'https://qlever.dev/api/wikidata', license: 'CC0-1.0', retrieved_at: '2026-11-16',
            sha256: inputHashes[name], homepage_sha256: checksums.get('all-homepages.tsv'),
            query: readFileSync(new URL(`${name}.rq`, queryDir), 'utf8').trim(),
            profile_address_source: profileAddressSource,
            rule: 'Omit company claims with government type paths unless directly selected as government or public university; route positive education or nonprofit facts to their categories; omit unresolved company homepage overlaps and conflicting ownership claims',
            domains: sorted, items_by_domain: Object.fromEntries(sorted.map(host => [host, domains[host]])),
        };
    });
}
await withStagedOutputs([output], ([path]) => writeFileSync(path,
    '/* Generated build-only Wikidata classification sources. */\n\n' + `export default ${JSON.stringify(groups)};\n`));
console.log(JSON.stringify({ hosts: hosts.size, unresolvedHomepage, companyGovernment, conflicting,
    categories: Object.fromEntries(Object.entries(groups).map(([category, sources]) =>
        [category, sources.map(source => ({ name: source.name, count: source.domains.length }))])) }, null, 2));
