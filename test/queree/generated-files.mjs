import { buildTaxonomy, writeTaxonomy } from '../../tools/queree-taxonomy.mjs';
import { checkGenerated, checkServerTaxonomy } from '../../tools/check-queree-generated.mjs';
import childProcess from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { loadWebsiteDomains } from '../../tools/make-queree-website-domains.mjs';
import { mock } from 'node:test';
import { once } from 'node:events';
import process from 'node:process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { withStagedOutputs } from '../../tools/queree-generated-files.mjs';

const work = mkdtempSync(join(tmpdir(), 'queree-generated-files-'));
try {
    const outputs = [ join(work, 'data'), join(work, 'manifest') ];
    outputs.forEach(path => writeFileSync(path, 'previous'));
    for ( const incomplete of [ false, true ] ) {
        await assert.rejects(withStagedOutputs(outputs, ([ data ]) => {
            writeFileSync(data, 'partial');
            if ( incomplete === false ) { throw new Error('generation failed'); }
        }));
        assert.deepEqual(outputs.map(path => readFileSync(path, 'utf8')), [ 'previous', 'previous' ]);
        assert.deepEqual(readdirSync(work).sort(), [ 'data', 'manifest' ]);
    }
    const rename = fs.renameSync;
    for ( const existing of [ true, false ] ) {
        if ( existing === false ) { rmSync(outputs[0]); }
        mock.method(fs, 'renameSync', (from, to) => {
            if ( to === outputs[1] ) { throw new Error('second rename failed'); }
            return rename(from, to);
        });
        try {
            await assert.rejects(withStagedOutputs(outputs, paths =>
                paths.forEach(path => writeFileSync(path, 'new'))), /second rename failed/);
        } finally {
            mock.restoreAll();
        }
        assert.equal(fs.existsSync(outputs[0]), existing);
        if ( existing ) { assert.equal(readFileSync(outputs[0], 'utf8'), 'previous'); }
        assert.equal(readFileSync(outputs[1], 'utf8'), 'previous');
        assert.equal(readdirSync(work).some(name => name.startsWith('.queree-generate-')), false);
    }
    await withStagedOutputs(outputs, paths => paths.forEach(path => writeFileSync(path, 'complete')));
    assert.deepEqual(outputs.map(path => readFileSync(path, 'utf8')), [ 'complete', 'complete' ]);

    outputs.forEach(path => writeFileSync(path, '0'));
    const writer = `
        import { withStagedOutputs } from ${JSON.stringify(new URL('../../tools/queree-generated-files.mjs', import.meta.url).href)};
        import { readFileSync, writeFileSync } from 'node:fs';
        await withStagedOutputs(${JSON.stringify(outputs)}, async paths => {
            const count = Number(readFileSync(${JSON.stringify(outputs[0])}, 'utf8')) + 1;
            await new Promise(resolve => setTimeout(resolve, 50));
            for (const path of paths) writeFileSync(path, String(count));
        });`;
    const children = [ 1, 2 ].map(() => spawn(process.execPath, [ '--input-type=module', '-e', writer ], { stdio: 'inherit' }));
    for ( const [ code ] of await Promise.all(children.map(child => once(child, 'close'))) ) {
        assert.equal(code, 0);
    }
    assert.deepEqual(outputs.map(path => readFileSync(path, 'utf8')), [ '2', '2' ], 'Concurrent updates must serialize reads and pair publication');

    // Recover the original domain lists offline, without touching runtime data.
    const domainManifestURL = new URL('../../tools/vendor/website-domains/provenance.json', import.meta.url);
    const domainManifest = JSON.parse(readFileSync(domainManifestURL, 'utf8'));
    const domainOutput = join(work, 'domain-output');
    const runDomainImport = manifest => execFileSync(process.execPath, [
        'tools/make-queree-website-domains.mjs', manifest, domainOutput,
    ], { stdio: 'pipe' });
    execFileSync(process.execPath, [ 'tools/make-queree-website-domains.mjs' ]);
    runDomainImport(fileURLToPath(domainManifestURL));
    for ( const name of [ 'commercial-domains.js', 'institutional-domains.js' ] ) {
        assert.equal(readFileSync(join(domainOutput, name), 'utf8'),
            readFileSync(new URL('../../src/js/queree/vendor/' + name, import.meta.url), 'utf8'),
            'Recovered inputs must reproduce complete modules, including untouched DOAJ data');
    }
    const previousDomains = readFileSync(join(domainOutput, 'commercial-domains.js'), 'utf8');
    const importerURL = new URL('../../tools/make-queree-website-domains.mjs', import.meta.url);
    const argv = process.argv;
    const originalRead = fs.readFileSync;
    const originalSpawn = childProcess.spawn;
    let locked = false;
    const sharedReads = new Set();
    mock.method(childProcess, 'spawn', (...args) => {
        const child = originalSpawn(...args);
        if ( args[0] === 'flock' ) {
            child.stdout.once('data', () => { locked = true; });
            child.once('close', () => { locked = false; });
        }
        return child;
    });
    mock.method(fs, 'readFileSync', (path, ...args) => {
        const module = /\/src\/js\/queree\/vendor\/((?:commercial|institutional)-domains\.js)$/.exec(String(path));
        if ( module ) {
            assert.ok(locked, 'Read shared list modules only after acquiring the generator lock');
            sharedReads.add(module[1]);
        }
        return originalRead(path, ...args);
    });
    syncBuiltinESMExports();
    try {
        process.argv = [ process.execPath, fileURLToPath(importerURL), fileURLToPath(domainManifestURL), join(work, 'locked-domain-output') ];
        await import(importerURL.href + '?lock-order-test');
        assert.equal(sharedReads.size, 2);
    } finally {
        process.argv = argv;
        mock.restoreAll();
        syncBuiltinESMExports();
    }
    const testManifest = join(work, 'domain-manifest.json');
    const badDomainManifest = JSON.parse(JSON.stringify(domainManifest));
    for ( const source of badDomainManifest.sources ) {
        for ( const file of source.files ) { file.file = new URL(file.file, domainManifestURL).href; }
    }
    const firstInput = badDomainManifest.sources[0].files[0];
    const oldSize = firstInput.bytes;
    firstInput.bytes++;
    writeFileSync(testManifest, JSON.stringify(badDomainManifest));
    assert.throws(() => runDomainImport(testManifest), /Source hash\/size mismatch/);
    firstInput.bytes = oldSize;
    const oldBlob = firstInput.git_blob_sha;
    firstInput.git_blob_sha = '0'.repeat(40);
    writeFileSync(testManifest, JSON.stringify(badDomainManifest));
    assert.throws(() => runDomainImport(testManifest), /Source Git blob mismatch/);
    firstInput.git_blob_sha = oldBlob;
    badDomainManifest.sources.pop();
    writeFileSync(testManifest, JSON.stringify(badDomainManifest));
    assert.throws(() => runDomainImport(testManifest), /manifest must cover/);
    assert.equal(readFileSync(join(domainOutput, 'commercial-domains.js'), 'utf8'), previousDomains,
        'A broken input or incomplete manifest must not publish partial updates');

    const tinyInput = join(work, 'domains.txt');
    const tinyFile = text => {
        writeFileSync(tinyInput, text);
        return { file: tinyInput, bytes: new TextEncoder().encode(text).length,
            sha256: createHash('sha256').update(text).digest('hex') };
    };
    const tinySource = { name: 'ut1_shopping', module: 'commercial-domains.js',
        source: 'https://source.example/', format: 'domains' };
    const readTiny = () => loadWebsiteDomains(pathToFileURL(testManifest));
    tinySource.files = [ tinyFile('# comment\r\nSECOND.example\r\nfirst.example\r\nsecond.example\r\n') ];
    writeFileSync(testManifest, JSON.stringify({ license: 'CC-BY-SA-4.0', sources: [ tinySource ] }));
    assert.deepEqual(readTiny()[0].data.domains, [ 'second.example', 'first.example' ],
        'Preserve original normalization, de-duplication and insertion order');
    tinySource.format = 'dropship-retailers';
    tinySource.files = [ tinyFile(JSON.stringify({ search: [ { domains: [ 'shop.example', 'SECOND.example' ] } ] })) ];
    writeFileSync(testManifest, JSON.stringify({ license: 'CC-BY-SA-4.0', sources: [ tinySource ] }));
    assert.deepEqual(readTiny()[0].data.domains, [ 'shop.example', 'second.example' ]);
    for ( const data of [ {}, { search: [ { domains: 'shop.example' } ] },
        { search: [ { domains: [ 'shop.example/path' ] } ] } ] ) {
        tinySource.files = [ tinyFile(JSON.stringify(data)) ];
        writeFileSync(testManifest, JSON.stringify({ sources: [ tinySource ] }));
        assert.throws(readTiny);
    }

    const output = join(work, 'taxonomy.sqlite3');
    const manifestPath = `${output}.json`;
    const options = {
        nonExclusiveHosts: [], nonExclusiveHostSuffixes: [],
        ownershipCategories: new Set(), ownershipHostnameKind() {},
    };
    const groups = {
        public_interest_organization: [ { name: 'test', domains: [ 'museum.example' ] } ],
        adult_domain: [ { name: 'adult', domains: [ 'adult.example' ] } ],
    };
    const taxonomy = buildTaxonomy(groups, options);
    assert.deepEqual(taxonomy.precedence, [
        'community_contribution', 'government_education', 'commercial_corporate',
        'professional_publication', 'public_interest_organization',
    ]);
    assert.ok(taxonomy.rows.some(([ category ]) => category === 'adult_domain'));
    writeFileSync(output, 'previous database');
    writeFileSync(manifestPath, 'previous manifest');
    mock.method(fs, 'renameSync', (from, to) => {
        if ( to === manifestPath ) { throw new Error('manifest publication failed'); }
        return rename(from, to);
    });
    try {
        await assert.rejects(writeTaxonomy(output, taxonomy, 'test-commit'), /manifest publication failed/);
    } finally {
        mock.restoreAll();
    }
    assert.equal(readFileSync(output, 'utf8'), 'previous database');
    assert.equal(readFileSync(manifestPath, 'utf8'), 'previous manifest');
    await writeTaxonomy(output, taxonomy, 'test-commit');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.sha256, createHash('sha256').update(readFileSync(output)).digest('hex'));
    const database = new DatabaseSync(output, { readOnly: true });
    try {
        assert.equal(database.prepare("SELECT domain FROM source_domain WHERE category = 'public_interest_organization'").get().domain, 'museum.example');
        assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'schema'").get().value, '1');
        assert.deepEqual(JSON.parse(database.prepare("SELECT value FROM metadata WHERE key = 'source_boundaries'").get().value),
            manifest.source_boundaries);
    } finally {
        database.close();
    }

    // The release parity check accepts unrelated changes, not changed taxonomy inputs.
    const git = (...args) => execFileSync('git', [ '-C', work, ...args ], { encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@example.invalid');
    fs.mkdirSync(join(work, 'src/js/queree'), { recursive: true });
    const community = join(work, 'src/js/queree/community-domains.js');
    writeFileSync(community, 'old social platforms');
    fs.mkdirSync(join(work, 'tools'));
    writeFileSync(join(work, 'tools/queree-source-groups.mjs'), `export const taxonomyGroups = ${JSON.stringify(groups)};`);
    writeFileSync(join(work, 'src/js/queree/nonexclusive-hosts.js'), 'export const nonExclusiveHosts = []; export const nonExclusiveHostSuffixes = [];');
    writeFileSync(join(work, 'tools/queree-ownership-sources.mjs'), 'export const ownershipCategories = new Set(); export function ownershipHostnameKind() {}');
    fs.mkdirSync(join(work, 'tools/vendor/reviewed-domains'), { recursive: true });
    const reviewTable = join(work, 'tools/vendor/reviewed-domains/reviewed.tsv');
    writeFileSync(reviewTable, 'reviewed decisions');
    writeFileSync(join(work, 'package.json'), '{"type":"module"}');
    for ( const name of [ 'make-queree-source-taxonomy.mjs', 'queree-taxonomy.mjs', 'queree-generated-files.mjs' ] ) {
        fs.copyFileSync(new URL(`../../tools/${name}`, import.meta.url), join(work, 'tools', name));
    }
    git('add', '.');
    git('commit', '-qm', 'baseline');
    const source_commit = git('rev-parse', 'HEAD');
    const foreign = mkdtempSync(join(tmpdir(), 'queree-foreign-checkout-'));
    try {
        execFileSync('git', [ 'init', '-q', foreign ]);
        const foreignOutput = join(foreign, 'taxonomy.sqlite3');
        execFileSync(process.execPath, [ join(work, 'tools/make-queree-source-taxonomy.mjs'), foreignOutput ], { cwd: foreign });
        assert.equal(JSON.parse(readFileSync(`${foreignOutput}.json`)).source_commit, source_commit,
            'Export provenance must come from the script checkout, not the caller');
    } finally {
        rmSync(foreign, { recursive: true, force: true });
    }
    writeFileSync(manifestPath, JSON.stringify({ source_commit }));
    await assert.rejects(checkServerTaxonomy(work, manifestPath, output), /hash\/length/);
    await writeTaxonomy(output, taxonomy, source_commit);
    await checkServerTaxonomy(work, manifestPath, output);
    const goodManifest = readFileSync(manifestPath);
    for ( const patch of [ { sha256: '0'.repeat(64) }, { revision: 'wrong' }, { row_count: 1 }, { source_boundaries: {} } ] ) {
        writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(goodManifest), ...patch }));
        await assert.rejects(checkServerTaxonomy(work, manifestPath, output));
    }
    writeFileSync(manifestPath, goodManifest);
    await writeTaxonomy(output, buildTaxonomy({ ...groups, adult_domain: [] }, options), source_commit);
    await assert.rejects(checkServerTaxonomy(work, manifestPath, output), /logical revision/);
    await writeTaxonomy(output, taxonomy, source_commit);
    writeFileSync(join(work, 'README'), 'unrelated documentation');
    await checkServerTaxonomy(work, manifestPath, output);
    writeFileSync(reviewTable, 'changed decision');
    await assert.rejects(checkServerTaxonomy(work, manifestPath, output), /matching export/);
    writeFileSync(reviewTable, 'reviewed decisions');
    writeFileSync(community, 'Quora and Stack Exchange');
    await assert.rejects(checkServerTaxonomy(work, manifestPath, output), /matching export/);

    // Tiny generator stand-ins exercise the release comparison's full file set.
    const generated = [
        'src/js/queree/vendor/website-lists.js', 'src/assets/queree/domain-index.bin',
        'src/js/queree/vendor/domain-index-data.js', 'src/js/queree/vendor/commerce-fingerprints.js',
        'src/js/queree/vendor/commerce-signals.js',
    ];
    for ( const path of generated ) {
        fs.mkdirSync(join(work, path, '..'), { recursive: true });
        writeFileSync(join(work, path), 'current');
    }
    for ( const [ tool, destinations ] of [
        [ 'website-lists', '[process.argv[3]]' ],
        [ 'domain-index', '[process.argv[2], process.argv[3]]' ],
        [ 'commerce-fingerprints', "[process.argv[4], resolve(process.argv[4], '../commerce-signals.js')]" ],
    ] ) {
        writeFileSync(join(work, 'tools', 'make-queree-' + tool + '.mjs'),
            "import {writeFileSync} from 'node:fs'; import {resolve} from 'node:path';" +
            "for (const path of " + destinations + ") writeFileSync(path, 'current');");
    }
    writeFileSync(join(work, 'tools', 'make-queree-website-domains.mjs'), '');
    checkGenerated(work);
    writeFileSync(join(work, 'tools', 'make-queree-website-domains.mjs'), 'throw new Error("changed raw domain source");');
    assert.throws(() => checkGenerated(work), /Command failed/);
    writeFileSync(join(work, 'tools', 'make-queree-website-domains.mjs'), '');
    for ( const path of generated ) {
        writeFileSync(join(work, path), 'stale');
        assert.throws(() => checkGenerated(work), /Stale generated file/);
        writeFileSync(join(work, path), 'current');
    }
} finally {
    rmSync(work, { recursive: true, force: true });
}
console.log('Passed: generation/publication rollback, SQLite integrity and server classification parity');
