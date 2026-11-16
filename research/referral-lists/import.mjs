#!/usr/bin/env node

/* globals process */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { resolve } from 'node:path';

const [ inputArgument, shortenerArgument, outputArgument ] = process.argv.slice(2);
if ( inputArgument === undefined || shortenerArgument === undefined ) {
    throw new Error(
        'Usage: research/referral-lists/import.mjs ' +
        'blocklist-referral-native.txt url-shorteners.txt [output.js]'
    );
}

const inputPath = resolve(inputArgument);
const outputPath = resolve(
    outputArgument || resolve(import.meta.dirname, 'domains.js')
);
const input = readFileSync(inputPath);
const text = input.toString('utf8').replace(/^\uFEFF/, '');
const domains = new Set();
const shortenerInput = readFileSync(resolve(shortenerArgument));
const shorteners = new Set();

for ( const [ index, rawLine ] of shortenerInput
    .toString('utf8').split(/\r?\n/).entries() ) {
    const line = rawLine.trim();
    if ( line === '' || line.startsWith('#') ) { continue; }
    const domain = domainToASCII(line.toLowerCase().replace(/\.$/, ''));
    if (
        domain === '' || domain.includes('.') === false ||
        new URL(`https://${domain}/`).hostname !== domain
    ) {
        throw new Error(`Invalid shortener hostname on line ${index + 1}: ${line}`);
    }
    shorteners.add(domain);
}

if ( shorteners.size === 0 ) { throw new Error('URL-shortener source had no domains'); }

for ( const [ index, rawLine ] of text.split(/\r?\n/).entries() ) {
    const line = rawLine.trim();
    if ( line === '' || line.startsWith('!') ) { continue; }
    const match = /^\|\|([A-Za-z0-9._-]+)\^$/.exec(line);
    if ( match === null ) {
        throw new Error(`Unsupported active rule on line ${index + 1}: ${line}`);
    }
    const domain = domainToASCII(match[1].toLowerCase().replace(/\.$/, ''));
    if (
        domain === '' || domain.includes('.') === false ||
        new URL(`https://${domain}/`).hostname !== domain
    ) {
        throw new Error(`Invalid hostname on line ${index + 1}: ${match[1]}`);
    }
    domains.add(domain);
}

if ( domains.size === 0 ) { throw new Error('Referral blocklist had no domains'); }

const excludedDomains = Array.from(domains).filter(domain => {
    const labels = domain.split('.');
    return labels.some((_, index) => shorteners.has(labels.slice(index).join('.')));
});
for ( const domain of excludedDomains ) { domains.delete(domain); }

const header = name => text.match(
    new RegExp(`^! ${name}:\\s*(.+)$`, 'mi')
)?.[1].trim();
const data = [ {
    name: 'hagezi_referral_blocklist',
    source: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/' +
        'main/adblock/blocklist-referral-native.txt',
    license: 'GPL-3.0-only',
    sha256: createHash('sha256').update(input).digest('hex'),
    retrieved_at: new Date().toISOString(),
    upstream_version: header('Version'),
    upstream_modified: header('Last modified'),
    excluded_sources: [ {
        name: 'peterdavehello_url_shorteners',
        source: 'https://raw.githubusercontent.com/PeterDaveHello/' +
            'url-shorteners/master/list',
        license: 'CC-BY-SA-4.0',
        sha256: createHash('sha256').update(shortenerInput).digest('hex'),
        retrieved_at: new Date().toISOString(),
        excluded_domains: excludedDomains.sort(),
    } ],
    domains: Array.from(domains).sort(),
} ];

writeFileSync(
    outputPath,
    '/* Generated from HaGeZi\'s Referral Blocklist. */\n\n' +
        `export default ${JSON.stringify(data)};\n`
);
console.log(
    `Wrote ${domains.size} affiliate referral domains to ${outputPath}; ` +
    `excluded ${excludedDomains.length} multipurpose shorteners`
);
