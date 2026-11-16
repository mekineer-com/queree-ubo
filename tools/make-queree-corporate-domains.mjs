#!/usr/bin/env node

/* globals process */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isProfileAddress, profileAddressSource } from './queree-profile-addresses.mjs';
import { communityDomainFromHostname } from '../src/js/queree/community-domains.js';
import { createHash } from 'node:crypto';
import { isNonExclusiveHost } from '../src/js/queree/nonexclusive-hosts.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { snapshotDate } from './queree-snapshot-date.mjs';
import { websiteHost } from './queree-website-host.mjs';
import { withStagedOutputs } from './queree-generated-files.mjs';

const args = process.argv.slice(2);
const ycMode = args[0] === '--yc';
if ( ycMode ) { args.shift(); }
const [ inputArgument, dateArgument, outputArgument ] = args;
if ( inputArgument === undefined ) {
    throw new Error(
        'Usage: tools/make-queree-corporate-domains.mjs [--yc] input.json YYYY-MM-DD [output.js]'
    );
}
const retrievedAt = snapshotDate(dateArgument);

const inputPath = resolve(inputArgument);
const outputPath = resolve(
    outputArgument || 'src/js/queree/vendor/corporate-domains.js'
);
const pslPath = resolve(
    'dist/build/uAssets/main/thirdparties/publicsuffix.org/list/' +
    'effective_tld_names.dat'
);
const input = readFileSync(inputPath);
const pslText = readFileSync(pslPath, 'utf8');

const query = [
    'PREFIX wd: <http://www.wikidata.org/entity/>',
    'PREFIX wdt: <http://www.wikidata.org/prop/direct/>',
    'SELECT DISTINCT ?item ?website WHERE {',
    '  ?item wdt:P31/wdt:P279* wd:Q891723;',
    '        wdt:P856 ?website.',
    '}',
].join('\n');
const parsed = JSON.parse(input);
if ( ycMode && Array.isArray(parsed) === false ) {
    throw new Error('YC response is not an array');
}
const domains = new Map();
const excluded = { archive: 0, invalid: 0, platform: 0, nonexclusive_host: 0, profile_address: 0 };
if ( ycMode ) {
    excluded.nonprofit_or_unknown = 0;
    excluded.status = 0;
}

for ( const binding of ycMode ? parsed : parsed.results?.bindings || [] ) {
    if ( ycMode && binding.nonprofit !== false ) {
        excluded.nonprofit_or_unknown += 1;
        continue;
    }
    if ( ycMode && [ 'Active', 'Public' ].includes(binding.status) === false ) {
        excluded.status += 1;
        continue;
    }
    const item = ycMode
        ? Number.isSafeInteger(binding.id) && binding.id > 0 ? String(binding.id) : undefined
        : binding.item?.value?.match(/\/entity\/(Q\d+)$/)?.[1];
    const website = ycMode ? binding.website : binding.website?.value || '';
    const domain = websiteHost(website);
    if ( item === undefined || domain === undefined ) {
        excluded.invalid += 1;
        continue;
    }
    if ( domain === 'web.archive.org' ) {
        excluded.archive += 1;
        continue;
    }
    if ( communityDomainFromHostname(domain) !== undefined ) {
        excluded.platform += 1;
        continue;
    }
    // A directory's own-host homepage can identify the service's owner.
    const address = new URL(website);
    if ( isNonExclusiveHost(domain) && (address.pathname !== '/' || address.search !== '') ) {
        excluded.nonexclusive_host += 1;
        continue;
    }
    if ( isProfileAddress(website) ) {
        excluded.profile_address += 1;
        continue;
    }
    let items = domains.get(domain);
    if ( items === undefined ) {
        items = new Set();
        domains.set(domain, items);
    }
    items.add(item);
}
if ( domains.size === 0 ) { throw new Error('Company response had no usable domains'); }

const sortedDomains = Array.from(domains.keys()).sort();
const itemsByDomain = Object.fromEntries(sortedDomains.map(domain => [
    domain,
    Array.from(domains.get(domain)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
]));
const name = ycMode ? 'yc_companies' : 'wikidata_public_companies';
await withStagedOutputs([ outputPath ], async ([ path ]) => {
    const existing = existsSync(outputPath)
        ? (await import(pathToFileURL(outputPath).href)).default
        : [];
    const sources = new Map(existing.map(source => [ source.name, source ]));
    sources.set(name, {
        name,
        ...(ycMode ? {
            source: 'https://yc-oss.github.io/api/companies/all.json',
            upstream: 'https://www.ycombinator.com/companies',
            license: 'No license declared',
            rule: 'nonprofit=false; status=Active or Public; shared services require root URL; omit profile addresses',
        } : {
            source: 'https://query.wikidata.org/sparql',
            license: 'CC0-1.0',
            class: 'Q891723',
            website_property: 'P856',
            query,
        }),
        sha256: createHash('sha256').update(input).digest('hex'),
        profile_address_source: profileAddressSource,
        public_suffix_sha256: createHash('sha256').update(pslText).digest('hex'),
        retrieved_at: retrievedAt,
        excluded,
        domains: sortedDomains,
        items_by_domain: itemsByDomain,
    });
    writeFileSync(path,
        '/* Generated from attributed company-directory website records. */\n\n' +
        `export default ${JSON.stringify(Array.from(sources.values()))};\n`);
});
console.log(`Wrote ${domains.size} ${name} domains to ${outputPath}: ${JSON.stringify(excluded)}`);
