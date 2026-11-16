#!/usr/bin/env node

/* globals process */

import { closeSync, createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isProfileAddress, profileAddressSource } from './queree-profile-addresses.mjs';
import { communityDomainFromHostname } from '../src/js/queree/community-domains.js';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { domainToASCII } from 'node:url';
import { finished } from 'node:stream/promises';
import { isNonExclusiveHost } from '../src/js/queree/nonexclusive-hosts.js';
import { openSourceSnapshot } from './queree-source-snapshot.mjs';
import { ownershipHostnameKind } from './queree-ownership-sources.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { websiteHost } from './queree-website-host.mjs';
import { withStagedOutputs } from './queree-generated-files.mjs';

const [ zipArgument, outputArgument ] = process.argv.slice(2);
if ( zipArgument === undefined ) {
    throw new Error(
        'Usage: tools/make-queree-charity-domains.mjs charity.zip [output.js]'
    );
}

const zipPath = resolve(zipArgument);
const outputPath = resolve(
    outputArgument || 'src/js/queree/vendor/public-interest-domains.js'
);
const pslPath = resolve(
    'dist/build/uAssets/main/thirdparties/publicsuffix.org/list/' +
    'effective_tld_names.dat'
);
const pslText = readFileSync(pslPath, 'utf8');

async function sha256(fd) {
    const hash = createHash('sha256');
    const input = createReadStream(null, { fd, start: 0, autoClose: false });
    input.on('data', chunk => hash.update(chunk));
    await finished(input);
    closeSync(fd);
    return hash.digest('hex');
}

function normalizeEmailDomain(raw) {
    const email = raw.trim().toLowerCase();
    const at = email.lastIndexOf('@');
    if ( at <= 0 ) { return; }
    const hostname = domainToASCII(email.slice(at + 1).replace(/\.$/, '')).replace(/^www\./, '');
    if ( ownershipHostnameKind(hostname) === undefined ) { return; }
    return hostname;
}

const zipFD = openSourceSnapshot(zipPath);
const unzip = spawn('unzip', [ '-p', '/proc/self/fd/3', 'publicextract.charity.json' ],
    { stdio: [ 'ignore', 'pipe', 'inherit', zipFD ] });
const unzipExited = new Promise(resolveStatus => unzip.on('exit', resolveStatus));
const jq = spawn('jq', [
    '--stream',
    '-r',
    'select(length == 2 and (.[0] | length) == 2) | ' +
    'select(.[0][1] == "date_of_extract" or ' +
    '.[0][1] == "charity_registration_status" or ' +
    '.[0][1] == "charity_contact_email" or ' +
    '.[0][1] == "charity_contact_web") | ' +
    '[.[0][0], .[0][1], (.[1] // "")] | @tsv',
], { stdio: [ unzip.stdout, 'pipe', 'inherit' ] });
const jqExited = new Promise(resolveStatus => jq.on('exit', resolveStatus));

const domains = new Set();
const excluded = { platform: 0, nonexclusive_host: 0, profile_address: 0 };
let extractDate = '';
let record;

function finishRecord() {
    if ( record?.status !== 'Registered' ) { return; }
    const website = websiteHost(record.web, true);
    if ( website === undefined ) { return; }
    if ( website !== normalizeEmailDomain(record.email) ) { return; }
    if ( communityDomainFromHostname(website) !== undefined ) {
        excluded.platform += 1;
        return;
    }
    if ( isNonExclusiveHost(website) ) {
        excluded.nonexclusive_host += 1;
        return;
    }
    if ( isProfileAddress(record.web) ) {
        excluded.profile_address += 1;
        return;
    }
    domains.add(website);
}

const lines = createInterface({ input: jq.stdout, crlfDelay: Infinity });
for await ( const line of lines ) {
    const [ index, field, ...parts ] = line.split('\t');
    if ( record?.index !== index ) {
        finishRecord();
        record = { index, status: '', email: '', web: '' };
    }
    const value = parts.join('\t');
    if ( field === 'date_of_extract' && extractDate === '' ) {
        extractDate = value.slice(0, 10);
    } else if ( field === 'charity_registration_status' ) {
        record.status = value;
    } else if ( field === 'charity_contact_email' ) {
        record.email = value;
    } else if ( field === 'charity_contact_web' ) {
        record.web = value;
    }
}
finishRecord();

const [ unzipStatus, jqStatus ] = await Promise.all([
    unzipExited,
    jqExited,
]);
if ( unzipStatus !== 0 || jqStatus !== 0 ) {
    throw new Error(`Extract pipeline failed: unzip=${unzipStatus}, jq=${jqStatus}`);
}
if ( extractDate === '' || domains.size === 0 ) {
    throw new Error('Charity extract did not contain usable records');
}

await withStagedOutputs([ outputPath ], async ([ path ]) => {
    const existing = existsSync(outputPath)
        ? (await import(pathToFileURL(outputPath).href)).default
            .filter(item => item.name !== 'charity_commission_england_wales')
        : [];
    const data = [ ...existing, {
        name: 'charity_commission_england_wales',
        source: 'https://ccewuksprdoneregsadata1.blob.core.windows.net/data/json/publicextract.charity.zip',
        license: 'OGL-3.0',
        sha256: await sha256(zipFD),
        public_suffix_sha256: createHash('sha256').update(pslText).digest('hex'),
        extract_date: extractDate,
        rule: 'registered_website_email_domain_match',
        profile_address_source: profileAddressSource,
        excluded,
        domains: Array.from(domains).sort(),
    } ];
    writeFileSync(path,
        '/* Generated from the Charity Commission daily extract. */\n\n' +
        `export default ${JSON.stringify(data)};\n`);
});
console.log(`Wrote ${domains.size} public-interest domains to ${outputPath}`);
