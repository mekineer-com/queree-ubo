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

const [ inputArgument, dateArgument, outputArgument ] = process.argv.slice(2);
if ( inputArgument === undefined ) {
    throw new Error(
        'Usage: tools/make-queree-wikidata-public-interest-domains.mjs ' +
        'wikidata.json YYYY-MM-DD [output.js]'
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
const input = readFileSync(inputPath);
const pslText = readFileSync(pslPath, 'utf8');

const classes = new Set([ 'Q33506', 'Q167346' ]); // Museum, botanical garden.

const query = [
    'PREFIX wd: <http://www.wikidata.org/entity/>',
    'PREFIX wdt: <http://www.wikidata.org/prop/direct/>',
    'SELECT DISTINCT ?item ?class ?website WHERE {',
    '  VALUES ?class { wd:Q33506 wd:Q167346 }',
    '  ?item wdt:P31 ?class;',
    '        wdt:P856 ?website.',
    '}',
].join('\n');
const parsed = JSON.parse(input);
const domains = new Map();
const excluded = {
    archive: 0,
    invalid: 0,
    out_of_scope: 0,
    platform: 0,
    nonexclusive_host: 0,
    profile_address: 0,
};

for ( const binding of parsed.results?.bindings || [] ) {
    const item = binding.item?.value?.match(/\/entity\/(Q\d+)$/)?.[1];
    const itemClass = binding.class?.value?.match(/\/entity\/(Q\d+)$/)?.[1];
    if ( item === undefined || itemClass === undefined ) {
        excluded.invalid += 1;
        continue;
    }
    if ( classes.has(itemClass) === false ) {
        excluded.out_of_scope += 1;
        continue;
    }
    const domain = websiteHost(binding.website?.value || '');
    if ( domain === undefined ) {
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
    if ( isNonExclusiveHost(domain) ) {
        excluded.nonexclusive_host += 1;
        continue;
    }
    if ( isProfileAddress(binding.website.value) ) {
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
if ( domains.size === 0 ) { throw new Error('Wikidata response had no usable domains'); }

const sortedDomains = Array.from(domains.keys()).sort();
const itemsByDomain = Object.fromEntries(sortedDomains.map(domain => [
    domain,
    Array.from(domains.get(domain)).sort((a, b) =>
        Number(a.slice(1)) - Number(b.slice(1))
    ),
]));
await withStagedOutputs([ outputPath ], async ([ path ]) => {
    const existing = existsSync(outputPath)
        ? (await import(pathToFileURL(outputPath).href)).default
            .filter(item => item.name !== 'wikidata_museums_botanical_gardens')
        : [];
    const data = [ ...existing, {
        name: 'wikidata_museums_botanical_gardens',
        source: 'https://query.wikidata.org/sparql',
        license: 'CC0-1.0',
        classes: Array.from(classes),
        website_property: 'P856',
        profile_address_source: profileAddressSource,
        sha256: createHash('sha256').update(input).digest('hex'),
        public_suffix_sha256: createHash('sha256').update(pslText).digest('hex'),
        retrieved_at: retrievedAt,
        query,
        excluded,
        domains: sortedDomains,
        items_by_domain: itemsByDomain,
    } ];
    writeFileSync(path,
        '/* Generated from official charity and public-interest website fields. */\n\n' +
        `export default ${JSON.stringify(data)};\n`);
});
console.log(`Wrote ${domains.size} Wikidata public-interest domains to ${outputPath}`);
