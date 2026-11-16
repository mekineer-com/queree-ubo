#!/usr/bin/env node

/* globals process */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readVerified } from './queree-source-snapshot.mjs';
import { withStagedOutputs } from './queree-generated-files.mjs';

export function loadWebsiteDomains(manifestURL) {
    const manifest = JSON.parse(readFileSync(manifestURL, 'utf8'));
    return manifest.sources.map(source => {
        const domains = new Set();
        const snapshot = createHash('sha256');
        for ( const file of source.files ) {
            const bytes = readVerified(file, manifestURL);
            snapshot.update(bytes);
            let entries;
            if ( source.format === 'domains' ) {
                entries = bytes.toString('utf8').split(/\r?\n/)
                    .map(line => line.trim()).filter(line => line && !line.startsWith('#'));
            } else {
                assert.equal(source.format, 'dropship-retailers');
                const data = JSON.parse(bytes);
                assert.ok(Array.isArray(data.search), 'Missing retailer search groups');
                entries = data.search.flatMap(group => {
                    assert.ok(Array.isArray(group.domains), 'Missing retailer domains');
                    return group.domains;
                });
            }
            // Ported from the original website_categories.mjs importer. Keep
            // insertion order and normalization, not a new classification rule.
            for ( const raw of entries ) {
                assert.equal(typeof raw, 'string', 'Website hostname must be a string');
                const value = raw.trim().toLowerCase();
                const hostname = new URL('https://' + value).hostname.toLowerCase().replace(/\.$/, '');
                assert.equal(hostname, value.replace(/\.$/, ''), `Unsupported domain: ${raw}`);
                assert.ok(!/[\s/*?#@\\]/.test(value) && hostname, `Unsupported domain: ${raw}`);
                domains.add(hostname);
            }
        }
        assert.ok(domains.size, `Empty source: ${source.name}`);
        return {
            module: source.module,
            data: {
                name: source.name,
                source: source.source,
                license: manifest.license,
                sha256: snapshot.digest('hex'),
                domains: Array.from(domains),
            },
        };
    });
}

if ( process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) ) {
    const [ manifestArgument, outputDirectory ] = process.argv.slice(2);
    const manifestURL = manifestArgument ? pathToFileURL(resolve(manifestArgument))
        : new URL('./vendor/website-domains/provenance.json', import.meta.url);
    const sources = loadWebsiteDomains(manifestURL);
    assert.deepEqual(sources.map(({ data }) => data.name).sort(), [
        'dropship_retailers', 'ut1_bank', 'ut1_press', 'ut1_shopping',
    ], 'The manifest must cover each original UT1/Dropship source exactly once');
    const generate = async paths => {
        const modules = new Map();
        for ( const { module, data } of sources ) {
            if ( !modules.has(module) ) {
                const url = new URL(`../src/js/queree/vendor/${module}`, import.meta.url);
                modules.set(module, { text: readFileSync(url, 'utf8'), data: (await import(url)).default });
            }
            const target = modules.get(module);
            assert.ok(target.data.some(source => source.name === data.name), `Unknown source: ${data.name}`);
            target.data = target.data.map(source => source.name === data.name ? data : source);
        }
        const outputs = Array.from(modules, ([ name, { text, data } ]) => {
            const generated = text.slice(0, text.indexOf('export default ')) +
                `export default ${JSON.stringify(data)};\n`;
            if ( !outputDirectory ) {
                assert.ok(generated === text, `Stale domain source: ${name}; regenerate and review it`);
            }
            return generated;
        });
        if ( paths ) {
            outputs.forEach((generated, index) => writeFileSync(paths[index], generated));
        }
    };
    if ( outputDirectory ) {
        mkdirSync(outputDirectory, { recursive: true });
        await withStagedOutputs(Array.from(new Set(sources.map(({ module }) => join(outputDirectory, module)))), generate);
    } else { await generate(); }
    console.log(`Verified ${sources.map(({ data }) => `${data.name}: ${data.domains.length}`).join('; ')}`);
}
