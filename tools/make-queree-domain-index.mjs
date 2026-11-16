#!/usr/bin/env node

/* globals Buffer, process */

import { mkdirSync, writeFileSync } from 'node:fs';
import { ownershipCategories, ownershipHostnameKind } from './queree-ownership-sources.mjs';
import HNTrieContainer from '../src/js/hntrie.js';
import { createHash } from 'node:crypto';
import { sourceGroups as groups } from './queree-source-groups.mjs';
import { nonExclusiveHostFromHostname } from '../src/js/queree/nonexclusive-hosts.js';
import { withStagedOutputs } from './queree-generated-files.mjs';

const outputBinary = process.argv[2] || 'src/assets/queree/domain-index.bin';
const outputManifest = process.argv[3] || 'src/js/queree/vendor/domain-index-data.js';
const container = new HNTrieContainer();
const categories = {};

function indexSource(source, category) {
    const ownership = ownershipCategories.has(category) || category === 'government_education';
    const bounded = ownership || category === 'shopping_domain';
    const nonexclusiveDomains = [];
    const inheritedDomains = [];
    const scopedDomains = new Map();
    for ( const domain of source.domains ) {
        const kind = bounded ? ownershipHostnameKind(domain) : 'inherited';
        if ( kind === undefined && ownership ) {
            throw new Error(`Invalid ownership domain ${domain} from ${source.name}`);
        }
        if ( kind === 'exact' ) {
            nonexclusiveDomains.push(domain);
        } else {
            const boundary = bounded ? nonExclusiveHostFromHostname(domain) : undefined;
            if ( boundary === undefined ) {
                inheritedDomains.push(domain);
            } else {
                if ( scopedDomains.has(boundary) === false ) { scopedDomains.set(boundary, []); }
                scopedDomains.get(boundary).push(domain);
            }
        }
    }
    const root = container.createTrieFromIterable(inheritedDomains);
    const { domains, items_by_domain, ...metadata } = source;
    void domains;
    void items_by_domain;
    // Separate roots keep uBO's shortest-match trie from discarding listed tenants.
    return bounded
        ? { ...metadata, root, nonexclusive_domains: nonexclusiveDomains.sort(),
            scoped_roots: Object.fromEntries(Array.from(scopedDomains, ([ boundary, domains ]) =>
                [ boundary, container.createTrieFromIterable(domains) ])) }
        : { ...metadata, root };
}

for ( const [ category, sources ] of Object.entries(groups) ) {
    categories[category] = sources.map(source => indexSource(source, category));
}

for ( const [ category, sources ] of Object.entries(groups) ) {
    for ( let i = 0; i < sources.length; i++ ) {
        const indexed = categories[category][i];
        for ( const domain of sources[i].domains ) {
            if ( indexed.nonexclusive_domains?.includes(domain) ) { continue; }
            container.setNeedle(domain);
            const boundary = nonExclusiveHostFromHostname(domain);
            const root = indexed.scoped_roots === undefined || boundary === undefined
                ? indexed.root : indexed.scoped_roots[boundary];
            if ( root === undefined || container.matches(root) === -1 ) {
                throw new Error(`Domain index lost ${domain} from ${sources[i].name}`);
            }
        }
    }
}

container.optimize();
const selfie = container.toSelfie();
const binary = Buffer.from(
    selfie.buf32.buffer,
    selfie.buf32.byteOffset,
    selfie.buf32.byteLength
);
mkdirSync('src/assets/queree', { recursive: true });
const manifest = {
    schema: 1,
    asset: '/assets/queree/domain-index.bin',
    sha256: createHash('sha256').update(binary).digest('hex'),
    checksum: selfie.checksum,
    byte_length: binary.length,
    categories,
};
await withStagedOutputs([ outputBinary, outputManifest ], ([ binaryPath, manifestPath ]) => {
    writeFileSync(binaryPath, binary);
    writeFileSync(manifestPath,
        `/* Generated compact hostname index metadata. */\n\nexport default ${JSON.stringify(manifest)};\n`);
});
console.log(`Wrote ${binary.length} bytes to ${outputBinary}`);
