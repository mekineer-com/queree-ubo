import { applyReviewedCategory, ownershipCategories, ownershipHostnameKind, parseReviewedDomains, reviewed, withoutInvalidOwnershipHosts, withoutSharedHostDeclarations } from '../../tools/queree-ownership-sources.mjs';
import { broadRecordCategories } from '../../tools/queree-wikidata-broad-categories.mjs';
import { Buffer } from 'node:buffer';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
    domainIndexData,
    listedDomainReasons,
    listedSourceDomainReasons,
    loadDomainIndexFromBuffer,
} from '../../src/js/queree/domain-index.js';
import { isNonExclusiveHost, nonExclusiveHostFromHostname, nonExclusiveHostSuffixes, nonExclusiveHosts } from '../../src/js/queree/nonexclusive-hosts.js';
import { isProfileAddress, profileAddressSource } from '../../tools/queree-profile-addresses.mjs';
import HNTrieContainer from '../../src/js/hntrie.js';
import assert from 'node:assert/strict';
import { buildTaxonomy } from '../../tools/queree-taxonomy.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { affiliateSources, promotionSources } from '../../src/js/queree/vendor/website-lists.js';
import { listedPromotionalURLReasons } from '../../src/js/queree/website-lists.js';
import wikidataBroad from '../../tools/vendor/wikidata-broad-domains.js';

const work = mkdtempSync(join(tmpdir(), 'queree-corporate-sources-'));
const output = join(work, 'sources.mjs');
const input = join(work, 'input.json');
const read = (file = output) => JSON.parse(readFileSync(file, 'utf8').split('export default ')[1].trim().slice(0, -1));
const generate = (...args) => execFileSync(process.execPath, [
    'tools/make-queree-corporate-domains.mjs', ...args, input, '2026-11-12', output,
]);

for ( const url of [
    'https://medium.com/@charity', 'https://linktr.ee/charity',
    'https://www.inaturalist.org/people/charity/', 'https://discourse.mozilla.org/u/charity',
    'https://www.inaturalist.org/people/charity?utm_source=directory',
    'https://www.inaturalist.org/%70eople/charity',
    'https://www.inaturalist.org/p%65ople/charity',
    'https://tieba.baidu.com/i/sys/user_json?utm_source=directory&ie=utf-8&un=charity',
    'www.patreon.com/charity', 'https://blog.naver.com/charity',
] ) { assert.equal(isProfileAddress(url), true, url); }
for ( const url of [
    'https://inaturalist.org/', 'https://archive.org/', 'https://freecodecamp.org/',
    'https://medium.com/about', 'https://ordinary.example/about',
    'https://linktr.ee.evil.example/charity', 'https://unlisted.linktr.ee/charity',
    'https://tieba.baidu.com/i/sys/user_json?ie=utf-8',
    'https://tieba.baidu.com/i/sys/user_json?un=charity&ie=wrong',
    'https://tieba.baidu.com/i/sys/user_json?un=&ie=utf-8',
    'https://inaturalist.org/?utm_source=directory',
    'mailto:charity@example.org', 'not a URL',
] ) { assert.equal(isProfileAddress(url), false, url); }
assert.match(profileAddressSource.sha256, /^[a-f0-9]{64}$/);
const guarded = withoutSharedHostDeclarations({
    name: 'old_snapshot', domains: [ 'fb.com', 'geocities.com', 'inaturalist.org', 'charity.wordpress.com' ],
    items_by_domain: { 'fb.com': [ '1' ], 'geocities.com': [ '2' ], 'inaturalist.org': [ '3' ], 'charity.wordpress.com': [ '4' ] },
});
assert.deepEqual(guarded.domains, [ 'inaturalist.org', 'charity.wordpress.com' ]);
assert.equal(guarded.shared_host_excluded, 2);
const malformedHosts = [
    'gujaga.org,au', '1=museum.nhra.com', 'a..example.org', '-bad.example.org',
    'bad-.example.org', 'bad_host.example.org', `${'a'.repeat(64)}.org`,
    `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`,
];
for ( const host of malformedHosts ) { assert.equal(ownershipHostnameKind(host), undefined, host); }
const validHosts = [ 'abbey.herts.sch.uk', 'tenant.school.ck', 'xn--fa-hia.de',
    [ 'a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(57), 'org' ].join('.'),
];
for ( const host of validHosts ) { assert.equal(ownershipHostnameKind(host), 'inherited', host); }
const validSnapshot = withoutInvalidOwnershipHosts({ name: 'old_snapshot', domains: [ ...malformedHosts, ...validHosts ] });
assert.deepEqual(validSnapshot.domains, validHosts);
assert.equal(validSnapshot.invalid_host_excluded, malformedHosts.length);

const declarations = { name: 'wikidata_fixture',
    domains: [ 'city.kagoshima.lg.jp', 'theguardian.com', 'unknown.example' ],
    items_by_domain: { 'city.kagoshima.lg.jp': [ 'Q110582434' ],
        'theguardian.com': [ 'Q2665980' ], 'unknown.example': [ 'Q123' ] } };
assert.deepEqual(applyReviewedCategory(declarations, 'commercial_corporate').domains, [ 'theguardian.com', 'unknown.example' ]);
assert.equal(declarations.domains.length, 3, 'Original declarations remain intact');
assert.deepEqual(applyReviewedCategory({ ...declarations,
    domains: [ 'city.kagoshima.lg.jp' ], items_by_domain: { 'city.kagoshima.lg.jp': [ 'Q15674' ] },
}, 'government_education').domains, [ 'city.kagoshima.lg.jp' ], 'The explicit category is independent of source-record IDs');
const otherDirectory = { ...declarations, name: 'yc_companies' };
assert.deepEqual(applyReviewedCategory(otherDirectory, 'commercial_corporate').domains,
    [ 'theguardian.com', 'unknown.example' ], 'Reviewed domain decisions apply without comparing ID schemes');
assert.deepEqual(applyReviewedCategory({ name: 'government_fixture', domains: [ 'swisscom.ch', 'sbb.ch' ] },
    'government_education').domains, [], 'Corporate reviews also override government sources');

const broadSources = Object.values(wikidataBroad).flat();
const record = (claims, flags = [], government = false) => ({
    claims: new Map(claims), flags: new Set(flags), government,
});
const companyClaim = [ 'private-legal', 'commercial_corporate' ];
assert.deepEqual(broadRecordCategories(record([ companyClaim ])), [ companyClaim ]);
assert.deepEqual(broadRecordCategories(record([ companyClaim ], [ 'public_interest_organization' ])),
    [ [ 'private-legal', 'public_interest_organization' ] ]);
assert.deepEqual(broadRecordCategories(record([ companyClaim ], [ 'government_education' ], true)), []);
assert.deepEqual(broadRecordCategories(record([ companyClaim, [ 'government-direct', 'government_education' ] ],
    [ 'government_education' ], true)), [ [ 'government-direct', 'government_education' ] ]);
assert.deepEqual(broadRecordCategories(record([ companyClaim, [ 'public-universities', 'government_education' ] ],
    [ 'government_education', 'public_interest_organization' ], true)), [ [ 'public-universities', 'government_education' ] ]);
assert.deepEqual(broadRecordCategories(record([ companyClaim ], [ 'government_education' ])),
    [ [ 'private-legal', 'government_education' ] ]);
const broadHas = (category, domain) => (wikidataBroad[category] || []).some(source => source.domains.includes(domain));
assert.equal(wikidataBroad.professional_publication, undefined, 'Journal URLs do not establish publisher ownership');
assert.ok(broadHas('commercial_corporate', '01solar.es'));
assert.ok(broadHas('government_education', 'aalto.fi'));
assert.ok(broadHas('public_interest_organization', 'buntkicktgut.org'));
assert.equal(broadHas('government_education', 'big.at'), false, 'A government flag alone does not classify a company as a government portal');
for ( const source of broadSources ) {
    assert.equal(source.domains.includes('1link.jp'), false, 'Unreviewed non-root company conflicts stay out of new sources');
    assert.equal(source.domains.includes('nifty.com'), false, 'No new parent ownership match for the reviewed personal homepage host');
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    assert.match(source.query, /wdt:P856/);
}

try {
    const reviewHeader = 'domain\tcategory\torganisation\tevidence\treason\n';
    const reviewRows = [
        'authority.example\tgovernment_education\tAuthority\thttps://authority.example/department\tReviewed municipal publisher.',
        'company.example\tcommercial_corporate\tCompany\thttps://company.example/en/\tReviewed business publisher.',
        'nonprofit.example\tpublic_interest_organization\tCharity\thttps://nonprofit.example/\tReviewed nonprofit publisher.',
        'unknown.example\tunclassified\tUnconfirmed\thttps://unknown.example/\tExplicitly unresolved after review.',
    ];
    const reviewBytes = Buffer.from(reviewHeader + reviewRows.join('\n') + '\n');
    const reviewedSources = parseReviewedDomains(reviewBytes);
    assert.deepEqual(Object.fromEntries(reviewedSources.map(source => [source.category, source.domains])), {
        commercial_corporate: [ 'company.example' ], government_education: [ 'authority.example' ],
        public_interest_organization: [ 'nonprofit.example' ], unclassified: [ 'unknown.example' ],
    });
    assert.equal(reviewedSources[0].sha256, createHash('sha256').update(reviewBytes).digest('hex'));
    assert.deepEqual(reviewedSources[0].items_by_domain['company.example'], [ 'https://company.example/en/' ]);
    assert.deepEqual(parseReviewedDomains(reviewBytes), reviewedSources);
    for ( const bad of [ reviewHeader, reviewHeader + reviewRows[0] + '\n' + reviewRows[0],
        reviewHeader + 'company.example\t\tCompany\thttps://company.example/\tMissing human decision.',
        reviewHeader + 'www.company.example\tcommercial_corporate\tCompany\thttps://company.example/\tNoncanonical.',
        reviewHeader + 'Company.example\tcommercial_corporate\tCompany\thttps://company.example/\tNoncanonical.',
        reviewHeader + 'company.example/path\tcommercial_corporate\tCompany\thttps://company.example/\tNot a host.',
        reviewHeader + 'company.example\tcommercial_corporate\tCompany\t\tMissing evidence.',
        reviewHeader + reviewRows[0] + '\textra',
        JSON.stringify({ results: { bindings: [{ item: { value: 'Q1' }, class: { value: 'Q4830453' } }] } }),
    ] ) {
        assert.throws(() => parseReviewedDomains(Buffer.from(bad)));
    }
    assert.equal(reviewed[0].sha256, createHash('sha256').update(readFileSync(
        new URL('../../tools/vendor/reviewed-domains/reviewed.tsv', import.meta.url)
    )).digest('hex'));
    writeFileSync(output, 'export default [{"name":"preserved_source","domains":["example.net"]}];\n');
    const item = (id, website, nonprofit = false, status = 'Active') => ({ id, website, nonprofit, status });
    writeFileSync(input, JSON.stringify([
        item(1, 'https://www.skyvern.com/'),
        item(2, 'https://watsi.org', true),
        item(3, 'https://unknown.example.com', null),
        item(4, 'https://old.example.com', false, 'Inactive'),
        item(5, 'https://public.example.org', false, 'Public'),
        item(6, 'https://substack.com'),
        item(7, 'https://ycombinator.com'),
        item(8, 'https://apps.apple.com/us/app/example'),
        item(9, 'http://127.0.0.1/'),
        item(10, 'https://person.github.io'),
        item(11, 'https://github.com/owner/project'),
        item(12, 'https://youtube.com/company'),
        item(13, 'https://gitlab.com/person/project'),
        item(14, 'https://beacons.ai/person'),
        item(15, 'https://www.inaturalist.org/people/company?utm_source=directory'),
        item(16, 'https://affirm.com/'),
        item(17, 'https://affirm.com/cares'),
    ]));
    generate('--yc');
    let sources = read();
    assert.deepEqual(sources[0], { name: 'preserved_source', domains: [ 'example.net' ] });
    const yc = sources.find(source => source.name === 'yc_companies');
    assert.deepEqual(yc.domains, [ 'affirm.com', 'person.github.io', 'public.example.org', 'skyvern.com', 'substack.com', 'ycombinator.com' ]);
    assert.deepEqual(yc.items_by_domain['skyvern.com'], [ '1' ]);
    assert.equal(yc.excluded.nonprofit_or_unknown, 2);
    assert.equal(yc.excluded.status, 1);
    assert.equal(yc.excluded.nonexclusive_host, 5);
    assert.equal(yc.excluded.profile_address, 1);
    assert.equal(yc.license, 'No license declared');
    const firstYC = readFileSync(output, 'utf8');
    generate('--yc');
    assert.equal(readFileSync(output, 'utf8'), firstYC);

    const binding = (id, url) => ({
        item: { value: `http://www.wikidata.org/entity/Q${id}` },
        class: { value: 'http://www.wikidata.org/entity/Q33506' },
        website: { value: url },
    });
    writeFileSync(input, JSON.stringify({ results: { bindings: [
        binding(123, 'https://www.example.org'),
        binding(124, 'https://ruhr-uni-bochum.de/'),
        binding(125, 'https://www.ruhr-uni-bochum.de/'),
        binding(126, 'https://www.fr/'),
        binding(127, 'https://inaturalist.org/people/museum'),
    ] } }));
    generate();
    sources = read();
    assert.equal(sources.length, 3);
    assert.deepEqual(sources.find(source => source.name === 'yc_companies'), yc,
        'Updating Wikidata must preserve the YC source');
    assert.deepEqual(sources.find(source => source.name === 'wikidata_public_companies').domains,
        [ 'example.org', 'ruhr-uni-bochum.de' ]);
    const firstWikidata = readFileSync(output, 'utf8');
    generate();
    assert.equal(readFileSync(output, 'utf8'), firstWikidata);
    execFileSync(process.execPath, [
        'tools/make-queree-wikidata-public-interest-domains.mjs', input, '2026-11-12', output,
    ]);
    const museums = read().find(source => source.name === 'wikidata_museums_botanical_gardens');
    assert.deepEqual(museums.domains, [ 'example.org', 'ruhr-uni-bochum.de' ]);
    assert.deepEqual(museums.items_by_domain['ruhr-uni-bochum.de'], [ 'Q124', 'Q125' ]);
    assert.equal(museums.excluded.invalid, 1);
    const museumSnapshot = readFileSync(output, 'utf8');
    execFileSync(process.execPath, [
        'tools/make-queree-wikidata-public-interest-domains.mjs', input, '2026-11-12', output,
    ]);
    assert.equal(readFileSync(output, 'utf8'), museumSnapshot);
    const firstMuseum = join(work, 'first-museum.mjs');
    execFileSync(process.execPath, [
        'tools/make-queree-wikidata-public-interest-domains.mjs', input, '2026-11-12', firstMuseum,
    ]);
    assert.deepEqual((await import(firstMuseum)).default[0].domains, museums.domains);
    const acncInput = join(work, 'acnc.csv');
    const firstACNC = join(work, 'first-acnc.mjs');
    const acncCSV = '\ufeffABN,Charity_Website\r\n12345678901,https://museum.example.org\r\n12345678902,https://inaturalist.org/people/charity\r\n';
    writeFileSync(acncInput, acncCSV);
    const generateACNC = () => execFileSync(process.execPath,
        [ 'tools/make-queree-acnc-domains.mjs', acncInput, '2026-11-12', firstACNC ], { stdio: 'pipe' });
    generateACNC();
    assert.deepEqual((await import(firstACNC)).default[0].domains, [ 'museum.example.org' ]);
    assert.equal((await import(firstACNC)).default[0].excluded.profile_address, 1);
    assert.equal((await import(firstACNC)).default[0].sha256,
        createHash('sha256').update(acncCSV).digest('hex'));
    const acncOutput = readFileSync(firstACNC, 'utf8');
    generateACNC();
    assert.equal(readFileSync(firstACNC, 'utf8'), acncOutput);
    for ( const tail of [ '12345678903', '12345678903,"https://truncated.example.org' ] ) {
        writeFileSync(acncInput, 'ABN,Charity_Website\n12345678901,https://museum.example.org\n' + tail);
        assert.throws(generateACNC, /ACNC CSV extraction failed/);
        assert.equal(readFileSync(firstACNC, 'utf8'), acncOutput);
    }
    const charityJSON = join(work, 'publicextract.charity.json');
    const charityZIP = join(work, 'charities.zip');
    const charity = host => ({
        date_of_extract: '2026-11-04',
        charity_registration_status: 'Registered',
        charity_contact_email: `contact@${host}`,
        charity_contact_web: `https://${host}/`,
    });
    for ( const last of Object.keys(charity('ruhr-uni-bochum.de')) ) {
        const record = charity('ruhr-uni-bochum.de');
        const value = record[last];
        delete record[last];
        record[last] = value;
        writeFileSync(charityJSON, JSON.stringify([
            record, { ...charity('museum.example.org'), unrelated: 'control' },
            { ...charity('inaturalist.org'), charity_contact_web: 'https://inaturalist.org/people/charity' },
        ]));
        rmSync(charityZIP, { force: true });
        execFileSync('zip', [ '-qj', charityZIP, charityJSON ]);
        const unrelated = join(work, 'unrelated.json');
        writeFileSync(unrelated, JSON.stringify([ charity('forged.example.org') ]));
        execFileSync('zip', [ '-qj', charityZIP, unrelated ]);
        execFileSync(process.execPath, [ 'tools/make-queree-charity-domains.mjs', charityZIP, output ]);
        const charities = read().find(source => source.name === 'charity_commission_england_wales');
        assert.deepEqual(charities.domains, [ 'museum.example.org', 'ruhr-uni-bochum.de' ], last);
        assert.equal(charities.excluded.profile_address, 1);
    }
    const firstCharity = join(work, 'first-charity.mjs');
    execFileSync(process.execPath, [ 'tools/make-queree-charity-domains.mjs', charityZIP, firstCharity ]);
    assert.deepEqual((await import(firstCharity)).default[0].domains, [ 'museum.example.org', 'ruhr-uni-bochum.de' ]);
    const zipBytes = readFileSync(charityZIP);
    const charityOutput = readFileSync(output, 'utf8');
    const bin = join(work, 'bin');
    mkdirSync(bin);
    const realUnzip = execFileSync('sh', [ '-c', 'command -v unzip' ], { encoding: 'utf8' }).trim();
    const replacement = join(work, 'replacement.zip');
    for ( const change of [ 'mv "$TEST_ZIP_REPLACEMENT" "$TEST_ZIP_INPUT"',
        'cat "$TEST_ZIP_REPLACEMENT" > "$TEST_ZIP_INPUT"' ] ) {
        writeFileSync(charityZIP, zipBytes);
        writeFileSync(replacement, 'replacement after parsing');
        writeFileSync(join(bin, 'unzip'), `#!/bin/sh\n"${realUnzip}" "$@" || exit $?\n${change}\n`);
        chmodSync(join(bin, 'unzip'), 0o755);
        execFileSync(process.execPath, [ 'tools/make-queree-charity-domains.mjs', charityZIP, output ], {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_ZIP_REPLACEMENT: replacement, TEST_ZIP_INPUT: charityZIP },
        });
        assert.equal(readFileSync(output, 'utf8'), charityOutput,
            'ZIP replacement or overwrite must preserve source data and the consumed archive hash');
    }
    console.log('Passed: company imports preserve sources, omit nonprofits and protect shared hosts');

    execFileSync(process.execPath, [
        'tools/make-queree-website-lists.mjs',
        'assets/queree/website-lists/provenance.json', output,
    ]);
    assert.equal(readFileSync(output, 'utf8'),
        readFileSync('src/js/queree/vendor/website-lists.js', 'utf8'),
        'Selected website lists must regenerate from the pinned source files');
    console.log('Passed: website-list data reproduce exactly from attributed upstream inputs');
    for ( const rule of [ '||example.test^', '||example.test^$third-party', '||example.test/path^' ] ) {
        const file = join(work, 'redirects.txt');
        const bytes = Buffer.from(`! Upstream comment\n${rule}\n`);
        writeFileSync(file, bytes);
        const descriptor = { file, bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex') };
        writeFileSync(input, JSON.stringify({
            license: 'test', license_file: descriptor, matcher: { files: [] },
            storefrontSources: [], affiliateSources: [], promotionSources: [],
            affiliateLinkSources: [ { name: 'test', format: 'adblock-domain-anchors', files: [ descriptor ] } ],
        }));
        const run = () => execFileSync(process.execPath, [
            'tools/make-queree-website-lists.mjs', input, output,
        ], { stdio: 'pipe' });
        if ( rule === '||example.test^' ) {
            run();
            assert.match(readFileSync(output, 'utf8'), /"example\.test"/);
        } else {
            assert.throws(run, error => /Expected an unmodified|Unsupported domain format/.test(error.stderr.toString()),
                'Do not silently strip future upstream path or request-type conditions');
        }
    }
} finally {
    rmSync(work, { recursive: true, force: true });
}

const readSource = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const generator = readSource('tools/make-queree-domain-index.mjs');
const fixtureContainer = new HNTrieContainer();
const indexSource = runInNewContext(
    generator.match(/^function indexSource\([\s\S]*?^\}/m)[0] + ';indexSource',
    { container: fixtureContainer, ownershipCategories, ownershipHostnameKind, nonExclusiveHostFromHostname }
);
const ownership = [
    'commercial_corporate', 'government_education', 'professional_publication', 'public_interest_organization',
];
const fixtureCategories = {};
for ( const category of ownership ) {
    fixtureCategories[category] = [ indexSource({
        name: category,
        domains: [
            'squarespace.com', 'listed.squarespace.com', 'ordinary.example',
            'google.com', 'sites.google.com', 'listed.google.com', 'reddit.com',
            'ruhr-uni-bochum.de', 'apple.com', 'listed.apps.apple.com',
        ],
    }, category) ];
    assert.deepEqual(Array.from(fixtureCategories[category][0].nonexclusive_domains), [
        'google.com', 'listed.google.com', 'ruhr-uni-bochum.de', 'sites.google.com', 'squarespace.com',
    ]);
}
const nonprofit = indexSource({
    name: 'nonprofit', domains: [ 'charity.squarespace.com', 'charity.ordinary.example', 'charity.apps.apple.com' ],
}, 'public_interest_organization');
const blanketLists = [ 'shopping_domain', 'scam_domain' ].map(category =>
    indexSource({ name: category,
        domains: [ 'squarespace.com', 'listed.squarespace.com', 'apple.com', 'listed.apps.apple.com' ],
    }, category)
);
assert.deepEqual(Array.from(blanketLists[0].nonexclusive_domains), [
    'squarespace.com',
]);
assert.equal(blanketLists[1].nonexclusive_domains, undefined,
    'Safety filterlists retain their upstream wildcard semantics');
const tenantShops = [ indexSource({
    name: 'tenant_shops', domains: [ 'myshopify.com', 'listed.myshopify.com' ],
}, 'shopping_domain') ];

const selfie = fixtureContainer.toSelfie();
const fixtureData = { byte_length: selfie.buf32.byteLength, checksum: selfie.checksum };
const fixtureIndex = runInNewContext(
    readSource('src/js/queree/domain-index.js')
        .replace(/^import .*;\n/gm, '')
        .replace(/^export \{ domainIndexData \};\n?/m, '')
        .replace(/^export /gm, '') +
        ';({ listedDomainReasons, listedSourceDomainReasons, loadDomainIndexFromBuffer })',
    { HNTrieContainer, domainIndexData: fixtureData, nonExclusiveHostFromHostname, URL, Uint32Array }
);
fixtureIndex.loadDomainIndexFromBuffer(selfie.buf32.buffer.slice(
    selfie.buf32.byteOffset, selfie.buf32.byteOffset + selfie.buf32.byteLength
));
const truncatedHostname = `${'a'.repeat(255 - '.squarespace.com'.length)}.squarespace.com.attacker`;
assert.equal(fixtureIndex.listedDomainReasons(
    `https://${truncatedHostname}/`, blanketLists
).length, 0, 'An oversized hostname cannot inherit a match from the trie\'s truncated input');
for ( const category of ownership ) {
    const lists = fixtureCategories[category];
    const reasons = host => fixtureIndex.listedSourceDomainReasons(`https://${host}/`, lists);
    for ( const [ host, matched ] of [
        [ 'squarespace.com', 'squarespace.com' ],
        [ 'www.squarespace.com', 'squarespace.com' ],
        [ 'SQUARESPACE.COM.', 'squarespace.com' ],
        [ 'listed.squarespace.com', 'listed.squarespace.com' ],
        [ 'www.listed.squarespace.com', 'listed.squarespace.com' ],
        [ 'child.listed.squarespace.com', 'listed.squarespace.com' ],
        [ 'news.ordinary.example', 'ordinary.example' ],
        [ 'sites.google.com', 'sites.google.com' ],
        [ 'www.sites.google.com', 'sites.google.com' ],
        [ 'listed.google.com', 'listed.google.com' ],
        [ 'www.listed.google.com', 'listed.google.com' ],
        [ 'unknown.reddit.com', 'reddit.com' ],
        [ 'ruhr-uni-bochum.de', 'ruhr-uni-bochum.de' ],
        [ 'www.ruhr-uni-bochum.de', 'ruhr-uni-bochum.de' ],
        [ 'news.apple.com', 'apple.com' ],
        [ 'listed.apps.apple.com', 'listed.apps.apple.com' ],
        [ 'child.listed.apps.apple.com', 'listed.apps.apple.com' ],
    ] ) {
        assert.equal(reasons(host)[0]?.matched_hostname, matched, `${category}: ${host}`);
        assert.equal(reasons(host).length, 1, 'Do not duplicate root/www evidence');
    }
    for ( const host of [
        'fictional-person.squarespace.com', 'www.fictional-person.squarespace.com',
        'www.www.squarespace.com', 'squarespace.com.evil.test',
        'unknown.sites.google.com', 'child.listed.google.com',
        'independent.ruhr-uni-bochum.de',
        'apps.apple.com', 'www.apps.apple.com', 'unlisted.apps.apple.com',
        'unlisted.apps.apple.com.evil.test',
    ] ) {
        assert.equal(reasons(host).length, 0, `${category}: ${host}`);
    }
    for ( const url of [ 'not a URL', 'ftp://squarespace.com/', 'file:///squarespace.com' ] ) {
        assert.equal(fixtureIndex.listedSourceDomainReasons(url, lists).length, 0, url);
    }
    assert.equal(fixtureIndex.listedSourceDomainReasons('https://squarespace.com/', lists, 'custom')[0].kind,
        'custom');
    assert.equal(fixtureIndex.listedSourceDomainReasons('https://listed.squarespace.com/', lists)[0].matched_hostname,
        'listed.squarespace.com', 'Removing the parent must retain same-source tenant evidence');
}
const corporateLists = fixtureCategories.commercial_corporate;
assert.equal(fixtureIndex.listedSourceDomainReasons('https://charity.squarespace.com/', corporateLists).length, 0);
assert.equal(fixtureIndex.listedSourceDomainReasons('https://charity.squarespace.com/', [ nonprofit ])[0].matched_hostname,
    'charity.squarespace.com', 'A hosting company must not override the tenant nonprofit');
assert.equal(fixtureIndex.listedSourceDomainReasons('https://charity.apps.apple.com/', corporateLists).length, 0);
assert.equal(fixtureIndex.listedSourceDomainReasons('https://charity.apps.apple.com/', [ nonprofit ])[0].matched_hostname,
    'charity.apps.apple.com', 'An ancestor corporation must not override an independently listed tenant');
assert.equal(fixtureIndex.listedSourceDomainReasons('https://charity.ordinary.example/', corporateLists)[0].matched_hostname,
    'ordinary.example', 'Ordinary corporate ownership must still precede nonprofit evidence');
assert.equal(fixtureIndex.listedSourceDomainReasons(
    'https://fictional-person.squarespace.com/', [ blanketLists[0] ]
).length, 0, 'Shopping lists cannot inherit shared-service ownership');
assert.equal(fixtureIndex.listedDomainReasons(
    'https://fictional-person.squarespace.com/', [ blanketLists[1] ]
)[0].matched_hostname, 'squarespace.com');
for ( const [ host, shopping ] of [
    [ 'apps.apple.com', undefined ], [ 'unknown.apps.apple.com', undefined ],
    [ 'listed.apps.apple.com', 'listed.apps.apple.com' ],
    [ 'child.listed.apps.apple.com', 'listed.apps.apple.com' ],
] ) {
    assert.equal(fixtureIndex.listedSourceDomainReasons(`https://${host}/`, [ blanketLists[0] ])[0]?.matched_hostname,
        shopping, host);
    assert.equal(fixtureIndex.listedDomainReasons(`https://${host}/`, [ blanketLists[1] ])[0].matched_hostname,
        'apple.com', 'Safety-list wildcards must not stop at ownership boundaries');
}
for ( const [ host, matched ] of [
    [ 'unlisted.myshopify.com', undefined ],
    [ 'myshopify.com', 'myshopify.com' ],
    [ 'www.myshopify.com', 'myshopify.com' ],
    [ 'listed.myshopify.com', 'listed.myshopify.com' ],
    [ 'child.listed.myshopify.com', 'listed.myshopify.com' ],
] ) {
    assert.equal(fixtureIndex.listedSourceDomainReasons(
        `https://${host}/`, tenantShops
    )[0]?.matched_hostname, matched, host);
}
console.log('Passed: synthetic ownership indexes retain same-source tenants and exact services without blanket exemptions');

for ( const category of ownership ) {
    for ( const domain of [ 'fr', 'gov.uk', 'gob.mx', 'ba.gov.br', 'http', '0.0.0.1', ...malformedHosts ] ) {
        assert.throws(( ) => indexSource({ name: 'invalid', domains: [ domain ] }, category),
            /Invalid ownership domain/, `${category}: ${domain}`);
    }
}

const binary = readFileSync(new URL('../../src/assets/queree/domain-index.bin', import.meta.url));
loadDomainIndexFromBuffer(binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength));
const bundledCorporate = domainIndexData.categories.commercial_corporate;
const affiliatePublishers = affiliateSources.find(source => source.name === 'super_seo_affiliate_publishers');
assert.equal(affiliatePublishers.domains.length, 102);
assert.equal(new Set(affiliatePublishers.domains).size, 102);
assert.deepEqual(affiliatePublishers.source_files.map(file => file.file), [
    'affiliate-publishers/English.txt', 'affiliate-publishers/French.txt', 'affiliate-publishers/Multi.txt',
]);
assert.ok(affiliatePublishers.domains.includes('otherworldlyoracle.com'), 'Upstream attached comments are not part of hostnames');
assert.equal(bundledCorporate.some(source => source.name === affiliatePublishers.name), false,
    'Publisher-list membership must not be corporate ownership');
for ( const domain of affiliatePublishers.domains ) {
    for ( const host of [ domain, `www.${domain}` ] ) {
        const url = `https://${host}/ordinary-article`;
        assert.ok(listedPromotionalURLReasons(url).some(reason =>
            reason.kind === 'affiliate_publisher' && reason.list === affiliatePublishers.name), host);
        assert.ok(listedDomainReasons(url, domainIndexData.categories.affiliate_publisher).length > 0, host);
    }
}
for ( const url of [ 'https://nascompares.com.example.org/', 'https://stackverdict.org/' ] ) {
    assert.equal(listedPromotionalURLReasons(url).some(reason => reason.kind === 'affiliate_publisher'), false, url);
}
assert.equal(promotionSources.find(source => source.name === 'super_seo_advertorials').rules.length, 9);
console.log('Passed: all 102 affiliate publishers are advertising evidence with native hostname scope, not Corporations');
for ( const host of [ 'apps.apple.com', 'www.apps.apple.com', 'queree-test.apps.apple.com' ] ) {
    assert.equal(listedSourceDomainReasons(`https://${host}/`, bundledCorporate).length, 0, host);
}
assert.equal(listedSourceDomainReasons('https://fictional-person.squarespace.com/', bundledCorporate).length, 0);
for ( const host of [ 'squarespace.com', 'www.squarespace.com' ] ) {
    assert.ok(listedSourceDomainReasons(`https://${host}/`, bundledCorporate)
        .some(reason => reason.matched_hostname === 'squarespace.com'), host);
}
assert.ok(listedSourceDomainReasons('https://news.microsoft.com/', bundledCorporate)
    .some(reason => reason.matched_hostname === 'microsoft.com'));
for ( const host of [ 'fictional-person.fr', 'ordinary.gob.mx', 'ordinary.ba.gov.br' ] ) {
    assert.equal(listedSourceDomainReasons(`https://${host}/`, bundledCorporate).length, 0, host);
}
const bundledPublicInterest = domainIndexData.categories.public_interest_organization;
for ( const host of malformedHosts ) {
    assert.equal(listedSourceDomainReasons(`https://${host}/`, bundledPublicInterest).length, 0, host);
}
for ( const host of [
    'teamunify.com', 'eteamz.com', 'troopwebhost.org', 'bridgewebs.com',
    'leagueathletics.com', 'teamsnap.com', 'patreon.com', 'fb.com', 'fb.me',
    'youtu.be', 'tiktok.com', 'about.me', 'squareup.com', 'donorbox.org',
    'affirm.com', 'qsl.net', 'geocities.com', 'freewebs.com', 'angelfire.com',
    'myspace.com', 'neighborhoodlink.com', 'rootsweb.ancestry.com',
] ) {
    assert.equal(isNonExclusiveHost(host), true, host);
    for ( const address of [ host, `www.${host}`, `${host}/a-charity`, `queree-test.${host}` ] ) {
        assert.equal(listedSourceDomainReasons(`https://${address}/`, bundledPublicInterest).length, 0, address);
    }
}
assert.equal(isNonExclusiveHost('altru.com'), false, 'Wrong source address, not shared hosting');
for ( const host of [ 'archive.org', 'inaturalist.org', 'freecodecamp.org' ] ) {
    assert.ok(listedSourceDomainReasons(`https://${host}/`, bundledPublicInterest).length > 0, host);
}
assert.ok(listedSourceDomainReasons('https://ruhr-uni-bochum.de/', bundledPublicInterest)
    .some(reason => reason.matched_hostname === 'ruhr-uni-bochum.de'));
assert.equal(listedSourceDomainReasons('https://independent.ruhr-uni-bochum.de/', bundledPublicInterest).length, 0);
for ( const category of ownership ) {
    for ( const list of domainIndexData.categories[category] ) {
        for ( const domain of list.nonexclusive_domains || [] ) {
            for ( const host of [ domain, `www.${domain}` ] ) {
                assert.ok(listedSourceDomainReasons(`https://${host}/`, [ list ])
                    .some(reason => reason.matched_hostname === domain), host);
            }
        }
    }
}
console.log('Passed: bundled Squarespace ownership boundary, vendor roots and ordinary corporate inheritance');

const groups = {
    public_interest_organization: [ { name: 'university', domains: [ 'ruhr-uni-bochum.de' ] } ],
    government_education: [ { name: 'namespaces', domains: [ 'gov.uk' ] } ],
    shopping_domain: [ { name: 'shops', domains: [ 'myshopify.com', 'listed.myshopify.com' ] } ],
};
const taxonomyOptions = { nonExclusiveHosts, nonExclusiveHostSuffixes, ownershipCategories, ownershipHostnameKind };
const taxonomy = buildTaxonomy(groups, taxonomyOptions);
assert.deepEqual(taxonomy.sourceBoundaries, {
    nonexclusive_hosts: [ ...nonExclusiveHosts, 'myshopify.com', 'ruhr-uni-bochum.de' ].sort(),
    nonexclusive_host_suffixes: [ ...nonExclusiveHostSuffixes ].sort(),
});
assert.throws(() => buildTaxonomy({
    commercial_corporate: [ { name: 'invalid', domains: [ 'fr' ] } ],
}, taxonomyOptions), /Invalid ownership domain/);
for ( const key of [ 'nonExclusiveHosts', 'nonExclusiveHostSuffixes' ] ) {
    assert.notEqual(taxonomy.revision, buildTaxonomy(groups, {
        ...taxonomyOptions, [key]: [ ...taxonomyOptions[key], 'added.example' ],
    }).revision, `${key} changes must force server reclassification`);
}
console.log('Passed: schema-1 taxonomy shares existing guards and boundary changes alter its revision');

const doaj = domainIndexData.categories.professional_publication.find(source => source.name === 'doaj_journals');
assert.equal(doaj.license, 'CC0-1.0');
for ( const [ url, matches ] of [
    [ 'https://joss.theoj.org/', true ],
    [ 'https://joss.theoj.org/papers/example', true ],
    [ 'https://theoj.org/', false ],
    [ 'https://other.theoj.org/', false ],
    [ 'https://journals.plos.org/plosone/', false ],
] ) {
    assert.equal(listedSourceDomainReasons(url, [ doaj ]).length > 0, matches, url);
}
console.log('Passed: compiled DOAJ data recognizes journal hosts without promoting their parent or sibling sites');
