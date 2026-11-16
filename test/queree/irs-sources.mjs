import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isNonExclusiveHost } from '../../src/js/queree/nonexclusive-hosts.js';
import { join } from 'node:path';
import process from 'node:process';
import { tmpdir } from 'node:os';

const work = mkdtempSync(join(tmpdir(), 'queree-irs-sources-'));
const output = join(work, 'sources.mjs');
const input = join(work, '990n.zip');
const returnHeader = 'ORG_EIN,TAX_YEAR,TAX_PERIOD_END_DATE,RETURN_TIME_STAMP,F9_00_ORG_WEBSITE,F9_00_RETURN_FINAL_X\n';
const rows = [];
const charity = (ein, website, options = {}) => {
    rows.push([
        ein, options.year || '2025', 'Example, Charity', 'T',
        options.terminated || 'F', '01-01-2025', '12-31-2025', website,
        'PRIVATE OFFICER DO NOT RETAIN',
    ]);
    return `${ein},"Example, Charity",${options.subsection || '03'},${options.status || '01'}\n`;
};
const makeZip = () => execFileSync('python3', [ '-c',
    'import json,sys,zipfile\n' +
    'with zipfile.ZipFile(sys.argv[1], "w") as z:\n' +
    ' z.writestr("data-download-epostcard.txt", "\\n".join("|".join(r) for r in json.loads(sys.argv[2]))+"\\n\\n")',
    input, JSON.stringify(rows),
]);
const generate = (env = process.env) => execFileSync(process.execPath, [
    'tools/make-queree-irs-domains.mjs', input, work, '2026', '2026-11-12', output,
], { stdio: 'pipe', env });

try {
    for ( const host of [
        'docs.google.com', 'ww.sites.google.com', 'l.instagram.com',
        'clubs.bluesombrero.com', 'homeschool-life.com', 'gomotionapp.com',
        'givebacks.com', 'portal.clubrunner.ca', 'leagues.teamlinkt.com',
    ] ) { assert.equal(isNonExclusiveHost(host), true, host); }
    for ( const host of [
        'mychurch.weebly.com', 'history.wordpress.com', 'pta.givebacks.com',
        'docs.google.com.example.org',
    ] ) { assert.equal(isNonExclusiveHost(host), false, host); }
    writeFileSync(output, 'export default [{"name":"preserved_source","domains":["example.net"]},{"name":"irs_charities","domains":["obsolete.example.org"]}];\n');
    for ( const year of [ 2023, 2024, 2025 ] ) {
        writeFileSync(join(work, `nccs-header-${year}.csv`), returnHeader);
    }
    const header = 'EIN,NAME,SUBSECTION,STATUS\n';
    writeFileSync(join(work, 'eo1.csv'), header +
        charity('000000001', 'https://www.good.example.org/about') +
        charity('000000002', 'https://old.example.org', { year: '2022' }) +
        charity('000000003', 'https://ended.example.org', { terminated: 'T' }) +
        charity('000000004', 'https://trade.example.org', { subsection: '06' }));
    writeFileSync(join(work, 'eo2.csv'), header +
        charity('000000005', 'https://revoked.example.org', { status: '22' }) +
        charity('000000006', 'https://facebook.com/group') +
        charity('000000007', 'https://weebly.com/charity') +
        charity('000000008', 'https://www,malformed.org'));
    writeFileSync(join(work, 'eo3.csv'), header +
        charity('000000009', 'mailto:hello@example.org') +
        charity('000000010', 'http://127.0.0.1') +
        charity('000000011', 'https://skyvern.com') +
        charity('000000012', 'https://org.github.io/charity'));
    writeFileSync(join(work, 'eo4.csv'), header +
        charity('000000013', 'www.puerto-rico.example.org') +
        charity('000000014', '') +
        charity('000000015', 'https://good.example.org/other') +
        charity('000000017', 'https://typo.0rg') +
        charity('000000021', 'https://www.inaturalist.org/people/example?utm_source=directory') +
        charity('000000022', 'https://troopwebhost.org/TroopExample') +
        charity('000000023', 'https://charity.squarespace.com/') +
        charity('000000024', 'https://magatama-sato.com/information') +
        charity('000000025', 'https://abbey.herts.sch.uk/') +
        charity('000000026', 'https://charity.school.ck/') +
        charity('000000027', 'https://charity.myshopify.com/') +
        charity('000000028', 'https://charity.apps.apple.com/') +
        charity('000000029', 'https://sub.skyvern.com/') +
        charity('000000030', 'https://creditunion.usf.edu/') +
        charity('000000031', 'https://city.kawasaki.jp/'));
    rows.push([ '000000016', '2025', 'Unknown', 'T', 'F', '', '', 'https://absent.example.org' ]);
    makeZip();
    generate();
    const text = readFileSync(output, 'utf8');
    const sources = JSON.parse(text.split('export default ')[1].trim().slice(0, -1));
    assert.deepEqual(sources[0], { name: 'preserved_source', domains: [ 'example.net' ] });
    assert.equal(sources.length, 2, 'Refresh must replace the current IRS source');
    const irs = sources.find(source => source.name === 'irs_charities');
    const retainedDomains = [
        'abbey.herts.sch.uk', 'charity.apps.apple.com', 'charity.myshopify.com',
        'charity.school.ck', 'charity.squarespace.com', 'city.kawasaki.jp', 'magatama-sato.com',
    ];
    assert.deepEqual(irs.domains, [ ...retainedDomains, 'good.example.org', 'org.github.io', 'puerto-rico.example.org' ].sort());
    assert.deepEqual(irs.items_by_domain['good.example.org'], [ '000000001', '000000015' ]);
    assert.equal(irs.status_sources.length, 4);
    assert.equal(irs.counts.not_current_charity, 3);
    assert.equal(irs.counts.stale, 1);
    assert.equal(irs.counts.terminated, 1);
    assert.equal(irs.counts.missing_website, 1);
    // Homepage authority evidence corrects this city without invalidating its PSL exception.
    assert.deepEqual(irs.excluded, { invalid: 4, platform: 1, nonexclusive_host: 2, known_commercial: 3, profile_address: 1 });
    assert.equal(irs.profile_address_source.license, 'MIT');
    const sha256 = value => createHash('sha256').update(value).digest('hex');
    assert.equal(irs.content_sha256, sha256(rows.map(row => row.join('|')).join('\n') + '\n\n'));
    assert.equal(irs.sha256, sha256(readFileSync(input)));
    assert.equal(irs.status_sources[0].sha256, sha256(readFileSync(join(work, 'eo1.csv'))));
    assert.equal(irs.return_sources[0].sha256, sha256(readFileSync(join(work, 'nccs-header-2023.csv'))));
    assert.doesNotMatch(text, /PRIVATE OFFICER/);
    generate();
    assert.equal(readFileSync(output, 'utf8'), text, 'Identical inputs must retain the revision');

    appendFileSync(join(work, 'eo4.csv'), '000000018,Full filer,03,01\n000000019,Full filer,03,01\n000000020,Full filer,03,01\n');
    const fullRows = [
        [ '000000001', '2025', '2026-06-30', '2026-09-01T10:00:00Z', 'https://new.example.org', '' ],
        [ '000000012', '2025', '2025-12-31', '2026-01-01T10:00:00Z', '', '' ],
        [ '000000013', '2025', '2025-12-31', '2026-01-01T10:00:00Z', 'https://final.example.org', 'X' ],
        [ '000000018', '2024', '2024-12-31', '2025-05-01T20:00:00-07:00', 'https://later.example.org', '' ],
        [ '000000018', '2024', '2024-12-31', '2025-05-02T02:30:00Z', 'https://earlier.example.org', '' ],
        [ '000000018', '2023', '2023-12-31', '2026-05-02T10:00:00Z', 'https://old-period.example.org', '' ],
        [ '000000019', '2023', '2023-12-31', '2024-05-01T10:00:00Z', 'https://old-website.example.org', '' ],
        [ '000000019', '2024', '2024-12-31', '2025-05-01T10:00:00Z', '', '' ],
        [ '000000020', '2024', '2024-12-31', '2025-05-01T10:00:00Z', 'https://tie-one.example.org', '' ],
        [ '000000020', '2024', '2024-12-31', '2025-05-01T10:00:00Z', 'https://tie-two.example.org', '' ],
        [ '000000002', '2024', '2024-12-31', '2025-05-01T10:00:00Z', 'https://full-only.example.org', '' ],
        [ '000000003', '2024', '2024-12-31', '2025-05-01T10:00:00Z', 'https://before-final.example.org', '' ],
        [ '000000014', '2024', '2024-12-31', '2025-05-01T10:00:00Z', 'https://before-blank.example.org', '' ],
    ];
    writeFileSync(join(work, 'nccs-header-2024.csv'), returnHeader +
        fullRows.map(row => row.join(',')).join('\n') + '\n');
    generate();
    const combinedText = readFileSync(output, 'utf8');
    const combined = JSON.parse(combinedText.split('export default ')[1].trim().slice(0, -1))
        .find(source => source.name === 'irs_charities');
    assert.deepEqual(combined.domains, [ ...retainedDomains,
        'full-only.example.org', 'good.example.org', 'later.example.org', 'new.example.org',
    ].sort());
    assert.equal(combined.counts.ambiguous_ties, 1);
    assert.equal(combined.counts.blank_latest_with_prior_website, 4);
    assert.equal(combined.return_sources.length, 3);
    assert.equal(combined.snapshot_year, 2026);
    assert.equal(combined.minimum_tax_year, 2023);
    assert.match(combined.license, /ODC-By-1.0/);

    const errataBytes = readFileSync('tools/queree-irs-website-errata.json');
    const errata = JSON.parse(errataBytes);
    assert.deepEqual(combined.website_errata, {
        source: 'tools/queree-irs-website-errata.json', sha256: sha256(errataBytes), applied: [],
    });
    const bmfBeforeErratum = readFileSync(join(work, 'eo4.csv'));
    const returnsBeforeErratum = readFileSync(join(work, 'nccs-header-2024.csv'));
    appendFileSync(join(work, 'eo4.csv'),
        '450368330,Foundation fixture,03,01\n450310462,Independent fixture,03,01\n450368331,Unrelated fixture,03,01\n');
    const declaration = [ '450368330', '2024', '2024-12-31', '2025-11-07T14:23:51-06:00', 'WWW.ALTRU.COM', '' ];
    const controls = [
        [ '450310462', '2024', '2024-12-31', '2025-10-29T13:45:13-05:00', 'WWW.ALTRU.ORG', '' ],
        [ '450368331', ...declaration.slice(1) ],
    ];
    const generateErratum = declarations => {
        writeFileSync(join(work, 'nccs-header-2024.csv'), returnsBeforeErratum +
            [ ...controls, ...declarations ].map(row => row.join(',')).join('\n') + '\n');
        generate();
        return JSON.parse(readFileSync(output, 'utf8').split('export default ')[1].trim().slice(0, -1))
            .find(source => source.name === 'irs_charities');
    };
    const corrected = generateErratum([ declaration ]);
    assert.deepEqual(corrected.items_by_domain['altru.org'], [ '450310462', '450368330' ]);
    assert.deepEqual(corrected.items_by_domain['altru.com'], [ '450368331' ],
        'A declaration erratum must not become a blanket host exception');
    assert.deepEqual(corrected.website_errata.applied, errata);
    assert.equal(corrected.website_errata.applied[0].corrected_at, '2026-11-14');
    assert.equal(corrected.return_sources[1].sha256,
        sha256(readFileSync(join(work, 'nccs-header-2024.csv'))), 'Hash raw declared bytes, not corrected text');
    assert.equal(corrected.sha256, combined.sha256);
    assert.equal(corrected.retrieved_at, combined.retrieved_at, 'Correction date is not source retrieval date');
    for ( const [ name, declarations ] of [
        [ 'different EIN', [ [ '450368331', ...declaration.slice(1) ] ] ],
        [ 'different period', [ declaration.with(2, '2024-11-30') ] ],
        [ 'different filing time', [ declaration.with(3, '2025-11-07T14:23:52-06:00') ] ],
        [ 'different reported address', [ declaration.with(4, 'https://different.example.org') ] ],
        [ 'final filing', [ declaration.with(5, 'X') ] ],
        [ 'newer blank filing', [ declaration, declaration.with(3, '2025-11-08T14:23:51-06:00').with(4, '') ] ],
        [ 'newer final filing', [ declaration, declaration.with(3, '2025-11-08T14:23:51-06:00').with(5, 'X') ] ],
        [ 'contradictory equal-time filing', [ declaration, declaration.with(4, 'https://different.example.org') ] ],
    ] ) {
        const unchanged = generateErratum(declarations);
        assert.deepEqual(unchanged.website_errata.applied, [], name);
        assert.deepEqual(unchanged.items_by_domain['altru.org'], [ '450310462' ], name);
    }
    writeFileSync(join(work, 'eo4.csv'), bmfBeforeErratum);
    writeFileSync(join(work, 'nccs-header-2024.csv'), returnsBeforeErratum);
    generate();
    assert.equal(readFileSync(output, 'utf8'), combinedText, 'Removing the test declaration restores identical output');
    console.log('Passed: dated EIN/declaration erratum preserves independent claims, raw provenance and latest-filing rules');

    for ( const [ name, badRows ] of [
        [ 'eo4.csv', [ '"unterminated', '000000024,Short,03\n', '000000024,Extra,03,01,extra\n' ] ],
        [ 'nccs-header-2024.csv', [ '"unterminated', '000000001,2025\n', fullRows[0].join(',') + ',extra\n' ] ],
    ] ) {
        const path = join(work, name);
        const good = readFileSync(path);
        for ( const bad of badRows ) {
            writeFileSync(path, good.toString('utf8') + bad);
            assert.throws(generate);
            assert.equal(readFileSync(output, 'utf8'), combinedText, `Malformed ${name} must preserve sources`);
        }
        writeFileSync(path, good);
    }

    unlinkSync(join(work, 'nccs-header-2025.csv'));
    assert.throws(generate, /Missing required return table/);
    assert.equal(readFileSync(output, 'utf8'), combinedText);
    writeFileSync(join(work, 'nccs-header-2025.csv'), returnHeader);

    const bin = join(work, 'bin');
    mkdirSync(bin);
    const realPython = execFileSync('sh', [ '-c', 'command -v python3' ], { encoding: 'utf8' }).trim();
    const replacement = join(work, 'replacement.zip');
    const zipBytes = readFileSync(input);
    for ( const change of [ 'mv "$TEST_ZIP_REPLACEMENT" "$TEST_ZIP_INPUT"',
        'cat "$TEST_ZIP_REPLACEMENT" > "$TEST_ZIP_INPUT"' ] ) {
        writeFileSync(input, zipBytes);
        writeFileSync(replacement, 'replacement after parsing');
        // Gitless releases also run Python while verifying archived dependencies.
        writeFileSync(join(bin, 'python3'), `#!/bin/sh\n"${realPython}" "$@" || exit $?\ncase "$2" in */queree-irs-websites.py) ${change} ;; esac\n`);
        chmodSync(join(bin, 'python3'), 0o755);
        generate({ ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_ZIP_REPLACEMENT: replacement, TEST_ZIP_INPUT: input });
        assert.equal(readFileSync(output, 'utf8'), combinedText,
            'ZIP replacement or overwrite must preserve source data and the consumed archive hash');
    }
    makeZip();

    rows.push(rows[0]);
    makeZip();
    assert.throws(generate, /duplicate EINs/);
    assert.equal(readFileSync(output, 'utf8'), combinedText, 'Failed extraction must not overwrite sources');
    rows.pop();
    writeFileSync(join(work, 'eo4.csv'), 'WRONG_SCHEMA\n');
    assert.throws(generate, /lacks required columns/);
    assert.equal(readFileSync(output, 'utf8'), combinedText);
    console.log('Passed: IRS imports join all regions, merge forms chronologically and preserve sources on failure');
} finally {
    rmSync(work, { recursive: true, force: true });
}
