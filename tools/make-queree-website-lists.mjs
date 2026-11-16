#!/usr/bin/env node

/* globals process */

import { domainToASCII, fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseMatchPattern } from '../src/js/queree/vendor/ublacklist/match-pattern.js';
import { readVerified } from './queree-source-snapshot.mjs';
import { resolve } from 'node:path';
import { withStagedOutputs } from './queree-generated-files.mjs';

const [ manifestArgument, outputArgument ] = process.argv.slice(2);
const manifestURL = manifestArgument
    ? pathToFileURL(resolve(manifestArgument))
    : new URL('../assets/queree/website-lists/provenance.json', import.meta.url);
const outputURL = outputArgument
    ? pathToFileURL(resolve(outputArgument))
    : new URL('../src/js/queree/vendor/website-lists.js', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestURL, 'utf8'));

function canonicalDomain(value) {
    if ( /[\s/\\:@?#%*]/.test(value) ) {
        throw new Error(`Unsupported domain format: ${value}`);
    }
    const domain = domainToASCII(value.toLowerCase().replace(/\.$/, ''));
    if (
        domain === '' || domain.includes('.') === false ||
        domain.length > 253 || domain.split('.').some(label => label.length > 63) ||
        new URL(`https://${domain}/`).hostname !== domain ||
        parseMatchPattern(`*://*.${domain}/*`) === null
    ) {
        throw new Error(`Invalid domain: ${value}`);
    }
    return domain;
}

function buildSource(source, kind) {
    if ( source.license_file ) { readVerified(source.license_file, manifestURL); }
    const snapshot = createHash('sha256');
    const entries = [];
    for ( const file of source.files ) {
        const bytes = readVerified(file, manifestURL);
        snapshot.update(bytes);
        for ( const [ index, rawLine ] of bytes.toString('utf8').split(/\r?\n/).entries() ) {
            const line = rawLine.replace(/#.*$/, '').trim();
            if ( line === '' || line.startsWith('#') ) { continue; }
            if ( source.format === 'adblock-domain-anchors' && line.startsWith('!') ) { continue; }
            try {
                if ( kind === 'domains' ) {
                    const domain = source.format === 'adblock-domain-anchors'
                        ? /^\|\|([^|^]+)\^$/.exec(line)?.[1] : line;
                    if ( domain === undefined ) {
                        throw new Error('Expected an unmodified ||domain^ rule without paths or modifiers');
                    }
                    entries.push(canonicalDomain(domain));
                    continue;
                }
                const slash = line.indexOf('/');
                if ( slash < 1 ) { throw new Error('Expected a domain and path'); }
                canonicalDomain(line.slice(0, slash));
                // Include the listed page as well as its existing descendant scope.
                for ( const pattern of [
                    `*://*.${line}`, `*://*.${line}?*`, `*://*.${line}/*`,
                ] ) {
                    const parsed = parseMatchPattern(pattern);
                    if (
                        parsed === null || parsed.allURLs ||
                        [ '*', 'http', 'https' ].includes(parsed.scheme) === false
                    ) {
                        throw new Error('Invalid HTTP(S) match pattern');
                    }
                    entries.push(pattern);
                }
            } catch (error) {
                throw new Error(`${file.file}:${index + 1}: ${line}`, { cause: error });
            }
        }
    }
    if ( entries.length === 0 ) {
        throw new Error(`Empty source: ${source.name}`);
    }
    return {
        name: source.name,
        source: source.source,
        license: source.license || manifest.license,
        ...(source.format ? { format: source.format } : {}),
        ...(source.license_file ? { license_file: source.license_file } : {}),
        ...(source.retrieved_at ? { retrieved_at: source.retrieved_at } : {}),
        ...(source.rule ? { rule: source.rule } : {}),
        sha256: snapshot.digest('hex'),
        source_files: source.files,
        [kind]: kind === 'domains' ? entries.sort() : entries,
    };
}

readVerified(manifest.license_file, manifestURL);
for ( const file of manifest.matcher.files ) { readVerified(file, manifestURL); }
const storefrontSources = manifest.storefrontSources.map(source => buildSource(source, 'domains'));
const affiliateSources = manifest.affiliateSources.map(source => buildSource(source, 'domains'));
const affiliateLinkSources = manifest.affiliateLinkSources.map(source => buildSource(source, 'domains'));
const promotionSources = [
    ...manifest.promotionSources.map(source => buildSource(source, 'rules')),
    ...affiliateSources.map(({ domains, ...source }) => ({
        ...source,
        kind: 'affiliate_publisher',
        rules: domains.map(domain => `*://*.${domain}/*`),
    })),
];
const output = '/* Generated by tools/make-queree-website-lists.mjs; do not edit. */\n\n' +
    `export const storefrontSources = ${JSON.stringify(storefrontSources, null, 2)};\n\n` +
    `export const promotionSources = ${JSON.stringify(promotionSources, null, 2)};\n\n` +
    `export const affiliateSources = ${JSON.stringify(affiliateSources, null, 2)};\n\n` +
    `export const affiliateLinkSources = ${JSON.stringify(affiliateLinkSources, null, 2)};\n`;
if ( existsSync(outputURL) === false || readFileSync(outputURL, 'utf8') !== output ) {
    await withStagedOutputs([ fileURLToPath(outputURL) ], ([ path ]) => writeFileSync(path, output));
}
console.log(
    `Verified ${storefrontSources.reduce((n, source) => n + source.domains.length, 0)} storefront domains; ` +
    `${promotionSources.reduce((n, source) => n + source.rules.length, 0)} promotion rules; ` +
    `${affiliateSources.reduce((n, source) => n + source.domains.length, 0)} affiliate publisher domains; ` +
    `${affiliateLinkSources.reduce((n, source) => n + source.domains.length, 0)} affiliate/tracked link domains`
);
